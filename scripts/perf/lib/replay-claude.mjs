#!/usr/bin/env node
// A fake `claude` that replays a recorded stream-json capture.
//
// A scratch-HOME daemon cannot run the real `claude` — the CLI reports "Not
// logged in" even with the keychain item present — so benchmarks replay a
// fixture instead. This exercises the real path: daemon ingest →
// provider_events → projection, with real provider output, no agent login and
// no quota.
//
// Protocol, matching what the daemon expects of a managed stream-json session:
// print the `system/init` line at startup (the daemon waits on it for
// readiness), then on each line of stdin print the rest of the capture, with
// every `session_id` rewritten to this session's own.
//
// Usage (as the provider binary): REPLAY_FIXTURE=<path.jsonl> replay-claude.mjs

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const fixture = process.env.REPLAY_FIXTURE;
if (!fixture) {
  process.stderr.write("replay-claude: REPLAY_FIXTURE is unset\n");
  process.exit(2);
}

const lines = readFileSync(fixture, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

// A distinct id per replayed session, so several concurrent fakes do not look
// to the daemon like one session talking over itself.
const sessionId = `replay_${process.pid}_${Date.now()}`;

// Per-event identity fields. Replaying a capture verbatim more than once
// produces identical identity_keys, and the daemon upserts by identity — so
// eight repeats of a 15-line capture ingested as nine rows, not 120. Every
// repeat therefore gets its own suffix on the fields identity is derived from.
const ID_FIELDS = ["uuid", "id", "tool_use_id", "hook_id", "parent_tool_use_id"];

function emit(event, pass) {
  const rewritten = { ...event };
  if ("session_id" in rewritten) rewritten.session_id = sessionId;
  if (pass > 0) {
    for (const field of ID_FIELDS) {
      if (typeof rewritten[field] === "string") rewritten[field] = `${rewritten[field]}-r${pass}`;
    }
    // Nested message payloads carry their own ids; Claude's stream puts the
    // tool_use id inside message.content[].
    if (rewritten.message && typeof rewritten.message === "object") {
      const message = { ...rewritten.message };
      if (typeof message.id === "string") message.id = `${message.id}-r${pass}`;
      if (Array.isArray(message.content)) {
        message.content = message.content.map((block) => {
          if (!block || typeof block !== "object") return block;
          const copy = { ...block };
          for (const field of ["id", "tool_use_id"]) {
            if (typeof copy[field] === "string") copy[field] = `${copy[field]}-r${pass}`;
          }
          return copy;
        });
      }
      rewritten.message = message;
    }
  }
  process.stdout.write(`${JSON.stringify(rewritten)}\n`);
}

const init = lines.find((line) => line.type === "system" && line.subtype === "init");
if (init) emit(init, 0);

const rest = lines.filter((line) => line !== init);

// How many times to replay the capture per received message. Lets one send
// produce a long transcript, which is the point when measuring cost against
// transcript length.
const repeats = Number(process.env.REPLAY_REPEATS ?? "1");

// Each received message replays the capture `repeats` times, every pass with
// its own identities, so one send can build a long transcript.
let pass = 0;
createInterface({ input: process.stdin }).on("line", () => {
  for (let i = 0; i < repeats; i += 1) {
    pass += 1;
    for (const line of rest) emit(line, pass);
  }
});
