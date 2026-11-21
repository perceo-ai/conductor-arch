#!/usr/bin/env node
// What does a busy minute actually cost?
//
// The other two benchmarks measure one RPC at a time. This one reproduces the
// complaint that started the work: several workspaces with agents streaming at
// once, and a laptop that gets hot. It drives real sessions through the daemon
// with replay-provider fakes, then reports what the daemon spent.
//
// The numbers that matter here are daemon CPU seconds and git subprocesses over
// a fixed window — both cumulative, so neither depends on the machine being
// idle the way a latency figure does.
//
// Usage: node scripts/perf/streaming-load.mjs [--workspaces 10] [--seconds 60]

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Scratch } from "./lib/scratch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
}

const WORKSPACES = arg("workspaces", 10);
const SECONDS = arg("seconds", 60);
// How often each fake agent is prodded into emitting another burst, standing in
// for a steadily streaming turn.
const SEND_INTERVAL_MS = arg("send-interval", 2000);

// Root is per-invocation so a before/after pair cannot share scratch state or
// race each other's leftover daemon.
const scratch = new Scratch(repoRoot, {
  root: process.env.PERF_ROOT ?? "/tmp/archductor-perf-streaming",
  countGit: true,
});

function installReplayProvider() {
  const replay = join(here, "lib/replay-claude.mjs");
  const launcher = join(scratch.root, "bin/replay-claude");
  mkdirSync(join(scratch.root, "bin"), { recursive: true });
  writeFileSync(
    launcher,
    `#!/bin/sh\n` +
      `export REPLAY_FIXTURE="${join(repoRoot, "crates/core/tests/fixtures/claude_stream/subagents_and_background_tasks.jsonl")}"\n` +
      `export REPLAY_REPEATS="${process.env.REPLAY_REPEATS ?? "4"}"\n` +
      `exec ${process.execPath} ${replay} "$@"\n`,
    { mode: 0o755 },
  );
  // Read from the repository root, not the worktree.
  const settingsDir = join(scratch.root, "repo/.archductor");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.toml"),
    `claude_code_executable_path = "${launcher}"\n`,
  );
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
    installReplayProvider();

    const names = [];
    for (let i = 1; i <= WORKSPACES; i += 1) {
      const name = `load-${i}`;
      scratch.cliRun(["archcar", "create-workspace", "demo", name, `perf/${name}`]);
      names.push(name);
    }
    for (const name of names) {
      scratch.cliRun(["session", "start", name, "--kind", "claude"]);
    }

    // Baseline after setup, so workspace creation's own git work is excluded.
    scratch.resetGitSpawns();
    const cpuBefore = scratch.cpuSeconds();
    const started = Date.now();

    // Every surface the desktop polls while watching a workspace, at the rate
    // the renderer now uses (250ms per thread, coalesced inventory).
    let pulls = 0;
    let bytes = 0;
    const sends = [];
    while (Date.now() - started < SECONDS * 1000) {
      const elapsed = Date.now() - started;
      if (elapsed / SEND_INTERVAL_MS > sends.length / names.length) {
        for (const name of names) {
          sends.push(name);
          try {
            scratch.cliRun(["session", "send", name, "--kind", "claude", "keep", "going"]);
          } catch {
            // A busy session queues the message; that is fine here.
          }
        }
      }
      const inventory = await scratch.rpc({ type: "list_workspaces" });
      bytes += inventory.bytes;
      pulls += 1;
      for (let threadId = 1; threadId <= names.length; threadId += 1) {
        const projection = await scratch.rpc({
          type: "get_chat_projection",
          thread_id: threadId,
        });
        bytes += projection.bytes;
        pulls += 1;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    const wall = (Date.now() - started) / 1000;
    const cpu = scratch.cpuSeconds() - cpuBefore;
    const spawns = scratch.gitSpawns();
    const rows = Number(scratch.sql("SELECT COUNT(*) FROM provider_events"));

    console.log(`\n${WORKSPACES} workspaces streaming for ${wall.toFixed(0)}s\n`);
    console.log(`  provider_events ingested : ${rows}`);
    console.log(`  RPCs served              : ${pulls}`);
    console.log(`  bytes served             : ${(bytes / 1024 / 1024).toFixed(1)}MB`);
    console.log(`  git subprocesses         : ${spawns}  (${(spawns / wall).toFixed(1)}/s)`);
    console.log(`  daemon CPU seconds       : ${cpu}  (${((cpu / wall) * 100).toFixed(0)}% of one core)`);
  } finally {
    for (let i = 1; i <= WORKSPACES; i += 1) {
      try {
        scratch.cliRun(["session", "stop", `load-${i}`]);
      } catch {
        // already gone
      }
    }
    scratch.stop();
  }
}

main().catch((err) => {
  scratch.stop();
  console.error(err);
  process.exit(1);
});
