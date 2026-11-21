#!/usr/bin/env node
// How much does one sidebar refresh cost, and how does that scale with the
// number of workspaces?
//
// The desktop answers six different archcar events with an uncoalesced
// `list_workspaces`, and the daemon answers each one by shelling out to git
// several times per active workspace. This measures both halves: wall time per
// request, and git subprocesses per request. The slope against workspace count
// is the finding — a flat cost would mean something caches, and nothing does
// today.
//
// Usage: node scripts/perf/inventory-cost.mjs [--max 12] [--samples 5]

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Scratch, stats, fmtMs } from "./lib/scratch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
}

const MAX_WORKSPACES = arg("max", 12);
const SAMPLES = arg("samples", 15);
// The git-counting shim is a shell script that execs the real git, so it adds
// real overhead per spawn. Counting and timing are therefore separate runs:
// pass --count-git 0 for honest latency, 1 for honest spawn counts.
//
// Since the daemon started caching, the spawn column is no longer per-request:
// the git work moved to a background refresher on its own tick, so whatever it
// does during a request lands in that request's count. It over-counts, which
// cannot manufacture a false win, but read it as "spawns during this window"
// rather than "spawns this call caused". For the daemon's steady-state cost,
// measure an idle daemon instead.
const COUNT_GIT = arg("count-git", 1) !== 0;
// The daemon memoizes the attention queue for `ATTENTION_CACHE_TTL` (3s, in
// crates/core/src/archcar/server.rs). Back-to-back samples would all be cache
// hits and say nothing about the sweep, so each attention sample first waits
// this long — outside both the timed and the counted window.
const ATTENTION_TTL_WAIT_MS = 3_400;

const scratch = new Scratch(repoRoot, {
  root: "/tmp/archductor-perf-inventory",
  countGit: COUNT_GIT,
});

async function measure(request) {
  const times = [];
  let bytes = 0;
  let spawns = 0;
  // One warm-up: the first request pays for lazily opened SQLite handles, which
  // is a fixed cost and not what this is about.
  await scratch.rpc(request);
  for (let i = 0; i < SAMPLES; i += 1) {
    scratch.resetGitSpawns();
    const started = performance.now();
    const res = await scratch.rpc(request);
    times.push(performance.now() - started);
    bytes = res.bytes;
    spawns = scratch.gitSpawns();
  }
  return { times: stats(times), bytes, spawns };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `measure`, but every sample is a real sweep: it waits out the daemon's
// attention cache before resetting the spawn count and starting the clock.
async function measureAttention(request) {
  const times = [];
  let bytes = 0;
  let spawns = 0;
  await scratch.rpc(request);
  for (let i = 0; i < SAMPLES; i += 1) {
    await sleep(ATTENTION_TTL_WAIT_MS);
    scratch.resetGitSpawns();
    const started = performance.now();
    const res = await scratch.rpc(request);
    times.push(performance.now() - started);
    bytes = res.bytes;
    spawns = scratch.gitSpawns();
  }
  return { times: stats(times), bytes, spawns };
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

    console.log("workspaces  list_workspaces (min)  git spawns   bytes     per-workspace");
    for (let count = 1; count <= MAX_WORKSPACES; count += 1) {
      scratch.cliRun([
        "archcar",
        "create-workspace",
        "demo",
        `ws-${count}`,
        `perf/ws-${count}`,
      ]);
      const listed = await measure({ type: "list_workspaces" });
      console.log(
        `${String(count).padStart(10)}  ` +
          `${fmtMs(listed.times.min).padStart(9)} (median ${fmtMs(listed.times.median)}, noise ${listed.times.noise.toFixed(1)})  ` +
          `${String(listed.spawns).padStart(10)}   ` +
          `${String(listed.bytes).padStart(7)}   ` +
          `${fmtMs(listed.times.min / count)} / ${(listed.spawns / count).toFixed(1)} spawns`,
      );
    }

    // The attention sweep builds a row per workspace the same way the
    // inventory does. It used to derive each one's git facts inline, so it
    // carried the cost this cache removes; this is the regression guard. It
    // only guards anything if each sample misses the attention cache.
    const attention = await measureAttention({ type: "list_attention" });
    console.log(
      `\nlist_attention at ${MAX_WORKSPACES} workspaces: ` +
        `${fmtMs(attention.times.min)} min, ${fmtMs(attention.times.median)} median, ` +
        `${attention.spawns} git spawns, ${attention.bytes} bytes`,
    );

    // What the desktop actually calls on startup and on window focus; it bundles
    // the workspace list with repositories and every workspace's chat threads.
    const snapshot = await measure({ type: "get_inventory_snapshot" });
    console.log(
      `\nget_inventory_snapshot at ${MAX_WORKSPACES} workspaces: ` +
        `${fmtMs(snapshot.times.min)} min, ${fmtMs(snapshot.times.median)} median, ` +
        `${snapshot.spawns} git spawns, ${snapshot.bytes} bytes`,
    );
  } finally {
    scratch.stop();
  }
}

main().catch((err) => {
  scratch.stop();
  console.error(err);
  process.exit(1);
});
