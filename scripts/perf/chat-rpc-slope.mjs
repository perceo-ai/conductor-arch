#!/usr/bin/env node
// How does the cost of one chat refresh grow with the length of the chat?
//
// The desktop answers each `session_messages_updated` — one per streamed
// provider event — with four full-thread RPCs, rate-limited to four runs a
// second per thread. The frequency is capped; the size of each run is not.
// This measures the size: latency and response bytes for each of those RPCs,
// swept against the number of provider_event rows in the thread.
//
// The slope is the finding. A flat cost means something caches; a linear one
// means the RPC re-reads the whole thread on every tick, which is what makes a
// long chat degrade and what this work is meant to remove.
//
// Real rows, not synthetic ones: a replay-provider fake streams a recorded
// capture through the daemon's real ingest path, then those rows are
// multiplied in SQL (with fresh identities, so items do not merge) to reach
// each target size. Payload shape therefore matches production exactly.
//
// Usage: node scripts/perf/chat-rpc-slope.mjs [--samples 5]

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Scratch, stats, fmtMs } from "./lib/scratch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
}

const SAMPLES = arg("samples", 15);
const SIZES = [100, 250, 500, 1000, 2000, 4000];

const scratch = new Scratch(repoRoot, { root: "/tmp/archductor-perf-chat" });

/** The four RPCs the renderer fires for one refresh tick. */
function tickRequests(threadId) {
  return [
    ["get_chat_projection", { type: "get_chat_projection", thread_id: threadId }],
    [
      "get_chat_snapshot",
      { type: "get_chat_snapshot", thread_id: threadId, include_provider_events: false },
    ],
    [
      "list_provider_interactions",
      { type: "list_provider_interactions", thread_id: threadId, pending_only: true },
    ],
    ["get_chat_plan", { type: "get_chat_plan", thread_id: threadId }],
  ];
}

/**
 * Cold and warm cost for one request, reported separately.
 *
 * The daemon caches a thread's projection, and folds in rows as it writes them
 * — so a bench that multiplies rows directly in SQLite, as this one does,
 * leaves the cache holding the pre-multiplication records. Ignoring that
 * reported a 56x speed-up that was really a stale answer: 64kB where the
 * uncached path returns 716kB.
 *
 * Each size therefore gets its own thread, never pulled before. Its first pull
 * is a genuine cache miss over the real row count; the samples after it are
 * warm hits on the same data.
 */
async function measure(request) {
  const coldStarted = performance.now();
  const cold = await scratch.rpc(request);
  const coldMs = performance.now() - coldStarted;

  const times = [];
  let bytes = cold.bytes;
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now();
    const res = await scratch.rpc(request);
    times.push(performance.now() - started);
    bytes = res.bytes;
  }
  return { cold: { ms: coldMs, bytes: cold.bytes }, times: stats(times), bytes };
}

/**
 * Clone the thread's provider_event rows until the thread holds `target` of
 * them.
 *
 * Identities are rewritten per copy, not reused: the projection merges records
 * by canonical id, so duplicating a row verbatim would grow the table without
 * growing the timeline and would measure the wrong thing.
 */
// Tags must be unique across the whole run, not just within one call: a tag
// reused on a later call collides with the rows an earlier one already wrote
// (identity_key is UNIQUE).
let dupTag = 0;

function rowCount(threadId) {
  return Number(
    scratch.sql(`SELECT COUNT(*) FROM provider_events WHERE chat_thread_id = ${threadId}`),
  );
}

function growTo(threadId, target) {
  // Doubling, copying every row including earlier copies, so reaching 4000
  // rows takes a handful of statements rather than hundreds.
  while (rowCount(threadId) < target) {
    const current = rowCount(threadId);
    const maxSeq = Number(
      scratch.sql(
        `SELECT COALESCE(MAX(received_sequence), 0) FROM provider_events WHERE chat_thread_id = ${threadId}`,
      ),
    );
    const tag = `perfdup${(dupTag += 1)}`;
    const wanted = Math.min(current, target - current);
    scratch.sql(`
      INSERT INTO provider_events (
        identity_key, provider, provider_event_id, provider_item_id,
        provider_thread_id, provider_turn_id, parent_provider_item_id,
        parent_provider_thread_id, workspace_id, chat_thread_id, process_id,
        phase, kind, provider_subtype, provider_sequence, received_sequence,
        timeline_seq, occurred_at_ms, normalized_payload_json, raw_json,
        schema_version, adapter_version, created_at, updated_at
      )
      SELECT
        identity_key || '-${tag}', provider,
        provider_event_id || '-${tag}', provider_item_id || '-${tag}',
        provider_thread_id, provider_turn_id || '-${tag}',
        parent_provider_item_id || '-${tag}',
        parent_provider_thread_id, workspace_id, chat_thread_id, process_id,
        phase, kind, provider_subtype, provider_sequence,
        received_sequence + ${maxSeq},
        timeline_seq + ${maxSeq}, occurred_at_ms,
        normalized_payload_json, raw_json,
        schema_version, adapter_version, created_at, updated_at
      FROM (
        SELECT * FROM provider_events
        WHERE chat_thread_id = ${threadId}
        ORDER BY received_sequence
        LIMIT ${wanted}
      )
    `);
  }
  return rowCount(threadId);
}

/**
 * Copy a thread's rows onto a brand-new chat thread, and return its id.
 *
 * Gives each size a thread the daemon has never projected, which is what makes
 * the first pull a genuine cache miss.
 */
function cloneThreadForSize(threadId, size) {
  const workspaceId = Number(
    scratch.sql(`SELECT workspace_id FROM chat_threads WHERE id = ${threadId}`),
  );
  scratch.sql(`
    INSERT INTO chat_threads (workspace_id, provider, title, status, created_at, updated_at)
    VALUES (${workspaceId}, 'claude', 'size-${size}', 'active', '1', '1')
  `);
  const clone = Number(scratch.sql("SELECT MAX(id) FROM chat_threads"));
  scratch.sql(`
    INSERT INTO provider_events (
      identity_key, provider, provider_event_id, provider_item_id,
      provider_thread_id, provider_turn_id, parent_provider_item_id,
      parent_provider_thread_id, workspace_id, chat_thread_id, process_id,
      phase, kind, provider_subtype, provider_sequence, received_sequence,
      timeline_seq, occurred_at_ms, normalized_payload_json, raw_json,
      schema_version, adapter_version, created_at, updated_at
    )
    SELECT
      identity_key || '-t${clone}', provider,
      provider_event_id || '-t${clone}', provider_item_id || '-t${clone}',
      provider_thread_id, provider_turn_id, parent_provider_item_id,
      parent_provider_thread_id, workspace_id, ${clone}, process_id,
      phase, kind, provider_subtype, provider_sequence, received_sequence,
      timeline_seq, occurred_at_ms, normalized_payload_json, raw_json,
      schema_version, adapter_version, created_at, updated_at
    FROM provider_events WHERE chat_thread_id = ${threadId}
  `);
  return clone;
}

/** Stream a recorded capture through the daemon's real ingest path. */
async function seedRealEvents() {
  const replay = join(here, "lib/replay-claude.mjs");
  const launcher = join(scratch.root, "bin/replay-claude");
  mkdirSync(join(scratch.root, "bin"), { recursive: true });
  writeFileSync(
    launcher,
    `#!/bin/sh\n` +
      `export REPLAY_FIXTURE="${join(repoRoot, "crates/core/tests/fixtures/claude_stream", process.env.REPLAY_FIXTURE_NAME ?? "subagents_and_background_tasks.jsonl")}"\n` +
      `export REPLAY_REPEATS="${process.env.REPLAY_REPEATS ?? "40"}"\n` +
      `exec ${process.execPath} ${replay} "$@"\n`,
    { mode: 0o755 },
  );
  // The provider executable override is read from the REPOSITORY root, not the
  // worktree: build_session_launch calls repository_settings(&repository.root_path)
  // (crates/core/src/workspace.rs:6881). Writing it into the worktree leaves the
  // daemon launching the real `claude`, which fails to log in under a scratch
  // HOME and produces a session_error instead of a transcript.
  const settingsDir = join(scratch.root, "repo/.archductor");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.toml"),
    `claude_code_executable_path = "${launcher}"\n`,
  );

  scratch.cliRun(["session", "start", "bench", "--kind", "claude"]);
  scratch.cliRun(["session", "send", "bench", "--kind", "claude", "measure", "this"]);

  const deadline = Date.now() + 60_000;
  let rows = 0;
  while (Date.now() < deadline) {
    rows = Number(scratch.sql("SELECT COUNT(*) FROM provider_events"));
    // Enough real rows that the SQL multiplier amplifies a realistic mix
    // rather than one short capture.
    if (rows >= 200) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (rows < 50) {
    throw new Error(
      `only ${rows} provider_events ingested — the replay provider probably did not run.\n` +
        `daemon log tail:\n${scratch.daemonLog().slice(-3000)}`,
    );
  }
  // Stop the session before the row multiplication begins: a live session keeps
  // writing, which both moves the row count under the sweep and holds the
  // database against the bulk inserts.
  try {
    scratch.cliRun(["session", "stop", "bench"]);
  } catch {
    // already gone
  }
  return rows;
}

async function main() {
  const repo = scratch.reset();
  await scratch.start();
  try {
    scratch.cliRun([
      "archcar",
      "add-repository",
      repo,
      "--name",
      "demo",
      "--default-branch",
      "main",
      "--workspace-parent",
      join(scratch.root, "ws"),
    ]);
    scratch.cliRun(["archcar", "create-workspace", "demo", "bench", "perf/bench"]);

    const seeded = await seedRealEvents();
    const threadId = Number(
      scratch.sql("SELECT chat_thread_id FROM provider_events WHERE chat_thread_id IS NOT NULL LIMIT 1"),
    );
    console.log(`seeded ${seeded} real provider_events on thread ${threadId}\n`);

    const header = ["rows", ...tickRequests(threadId).map(([name]) => name)];
    console.log(`${header[0].padStart(6)}  ${header.slice(1).map((n) => n.padStart(26)).join("")}`);

    for (const size of SIZES) {
      const rows = growTo(threadId, size);
      // A thread of its own, carrying a copy of the grown row set, so its first
      // pull is a real cache miss rather than a hit on stale records.
      const sizedThread = cloneThreadForSize(threadId, size);
      const cells = [];
      let warmTickMs = 0;
      let coldTickMs = 0;
      let tickBytes = 0;
      for (const [, request] of tickRequests(sizedThread)) {
        const result = await measure(request);
        warmTickMs += result.times.min;
        coldTickMs += result.cold.ms;
        tickBytes += result.bytes;
        cells.push(
          `${fmtMs(result.cold.ms)}→${fmtMs(result.times.min)}/${(result.bytes / 1024).toFixed(0)}kB`.padStart(26),
        );
      }
      console.log(`${String(rows).padStart(6)}  ${cells.join("")}`);
      console.log(
        `${"".padStart(6)}  → one tick: cold ${fmtMs(coldTickMs)}, warm ${fmtMs(warmTickMs)}, ${(tickBytes / 1024).toFixed(0)}kB` +
          `   (4 ticks/s/thread → ${((tickBytes * 4) / 1024 / 1024).toFixed(1)}MB/s)`,
      );
    }
  } finally {
    scratch.stop();
  }
}

main().catch((err) => {
  scratch.stop();
  console.error(err);
  process.exit(1);
});
