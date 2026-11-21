// Scratch archcar daemon for performance benchmarks.
//
// Everything here exists to make a measurement reproducible and to keep it off
// the developer's real state. The hazards it works around are all ones that
// have silently corrupted a measurement before:
//
//   - XDG_* alone is not enough isolation: `workspace create` without
//     --workspace-parent puts worktrees under $HOME/archductor/workspaces, so
//     HOME is overridden too.
//   - An agent running inside Archductor inherits ARCHDUCTOR_* env, including
//     ARCHDUCTOR_ARCHCAR_LISTEN, and a scratch daemon then dies on a port
//     clash while the real daemon keeps answering the socket. Stripped.
//   - A scratch daemon cannot be found by `pkill -f`: its scratch paths are in
//     the environment, not in argv. Kill by whoever holds the socket.
//   - XDG_CONFIG_HOME is deliberately left alone so `gh` can still read its
//     hosts file; the daemon probes it.

import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

/** Env with every ARCHDUCTOR_* inheritance removed. */
function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ARCHDUCTOR_")) continue;
    env[key] = value;
  }
  return env;
}

export class Scratch {
  constructor(repoRoot, { root = "/tmp/archductor-perf", countGit = false, profile } = {}) {
    this.repoRoot = repoRoot;
    this.root = root;
    this.countGit = countGit;
    // Release by default: debug binaries exaggerate every number here, and a
    // benchmark that measures the wrong build teaches the wrong lesson.
    this.profile = profile ?? process.env.PERF_PROFILE ?? "release";
    this.archcar = join(repoRoot, `target/${this.profile}/archcar`);
    this.cli = join(repoRoot, `target/${this.profile}/archductor`);
    this.daemon = null;
  }

  get socket() {
    return join(this.root, "state/archductor/archcar.sock");
  }

  get dbPath() {
    return join(this.root, "data/archductor/archductor.db");
  }

  get gitCountFile() {
    return join(this.root, "git-spawns");
  }

  env() {
    const env = cleanEnv();
    env.HOME = join(this.root, "home");
    env.XDG_DATA_HOME = join(this.root, "data");
    env.XDG_STATE_HOME = join(this.root, "state");
    if (this.countGit) {
      env.PATH = `${join(this.root, "bin")}:${env.PATH}`;
      env.ARCHDUCTOR_PERF_GIT_COUNT = this.gitCountFile;
    }
    return env;
  }

  /** Fresh scratch tree, a seed repository with one commit, and a git shim. */
  reset() {
    // A daemon left over from an earlier run keeps writing into this tree, and
    // a directory being written to while it is removed fails with ENOTEMPTY on
    // macOS rather than retrying. Stop whoever holds the socket first, then
    // remove with a few attempts.
    this.stop();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        break;
      } catch (err) {
        if (attempt === 4) throw err;
        spawnSync("sleep", ["1"]);
      }
    }
    for (const dir of ["home", "data", "state", "ws", "bin"]) {
      mkdirSync(join(this.root, dir), { recursive: true });
    }
    if (this.countGit) this.installGitShim();

    const repo = join(this.root, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...args) => {
      const res = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
    };
    spawnSync("git", ["init", "-q", "--initial-branch", "main", repo]);
    git("config", "user.email", "perf@example.com");
    git("config", "user.name", "Perf Bench");
    writeFileSync(join(repo, "README.md"), "# perf\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "seed");
    return repo;
  }

  /**
   * A `git` on PATH that counts invocations and then execs the real one.
   *
   * Counting spawns is the whole point of the inventory benchmark: the cost
   * there is subprocesses, not CPU in the daemon. Appending one byte per call
   * is used rather than a counter, so concurrent spawns cannot lose a count to
   * a read-modify-write race.
   */
  installGitShim() {
    const real = spawnSync("which", ["-a", "git"], { encoding: "utf8" })
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith(join(this.root, "bin")))[0];
    if (!real) throw new Error("no real git on PATH");
    const shim = join(this.root, "bin/git");
    writeFileSync(
      shim,
      `#!/bin/sh\n` +
        `if [ -n "$ARCHDUCTOR_PERF_GIT_COUNT" ]; then printf x >> "$ARCHDUCTOR_PERF_GIT_COUNT"; fi\n` +
        `exec ${real} "$@"\n`,
    );
    chmodSync(shim, 0o755);
    writeFileSync(this.gitCountFile, "");
  }

  gitSpawns() {
    if (!existsSync(this.gitCountFile)) return 0;
    return readFileSync(this.gitCountFile).length;
  }

  resetGitSpawns() {
    writeFileSync(this.gitCountFile, "");
  }

  async start() {
    const log = join(this.root, "daemon.log");
    writeFileSync(log, "");
    this.daemon = spawn(this.archcar, [], {
      env: this.env(),
      stdio: ["ignore", "appendFileSync" in globalThis ? "pipe" : "pipe", "pipe"],
      detached: false,
    });
    const logStream = [];
    this.daemon.stdout.on("data", (d) => logStream.push(d));
    this.daemon.stderr.on("data", (d) => logStream.push(d));
    this.daemon.on("exit", () => {
      writeFileSync(log, Buffer.concat(logStream));
    });
    this.daemonLog = () => Buffer.concat(logStream).toString();

    // Readiness probe: any answered request proves the socket is serving.
    // There is no `ping` in the protocol, so the cheapest real one stands in.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const res = await this.rpc({ type: "list_repositories" });
        if (res) return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new Error(`daemon did not come up:\n${this.daemonLog()}`);
  }

  /** Kill whoever holds the scratch socket — argv cannot identify it. */
  stop() {
    const holders = spawnSync("lsof", ["-t", this.socket], { encoding: "utf8" })
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const pid of holders) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // already gone
      }
    }
    this.daemon = null;
  }

  /** One request, one response line, over the unix socket. */
  rpc(payload) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socket);
      let buffer = "";
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        fn(arg);
      };
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id: randomUUID(), payload })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        try {
          finish(resolve, { bytes: Buffer.byteLength(line), message: JSON.parse(line) });
        } catch (err) {
          finish(reject, err);
        }
      });
      socket.on("error", (err) => finish(reject, err));
      socket.setTimeout(120_000, () => finish(reject, new Error("rpc timeout")));
    });
  }

  /** `archductor <args>` against this scratch daemon. */
  cliRun(args) {
    const res = spawnSync(this.cli, args, { env: this.env(), encoding: "utf8" });
    if (res.error) {
      throw new Error(`could not launch ${this.cli}: ${res.error.message}`);
    }
    if (res.status !== 0) {
      throw new Error(
        `archductor ${args.join(" ")} exited ${res.status}` +
          `\nstdout: ${res.stdout ?? "(none)"}\nstderr: ${res.stderr ?? "(none)"}`,
      );
    }
    return res.stdout;
  }

  sql(statement) {
    // The daemon holds the database while a session is live, so a bare sqlite3
    // call loses the race with "database is locked".
    const res = spawnSync("sqlite3", ["-cmd", ".timeout 30000", this.dbPath, statement], {
      encoding: "utf8",
    });
    if (res.status !== 0) throw new Error(`sqlite3: ${res.stderr}`);
    return res.stdout.trim();
  }

  /** Daemon CPU seconds consumed so far, for before/after deltas. */
  cpuSeconds() {
    const holders = spawnSync("lsof", ["-t", this.socket], { encoding: "utf8" })
      .stdout.split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let total = 0;
    for (const pid of holders) {
      const out = spawnSync("ps", ["-o", "cputime=", "-p", pid], { encoding: "utf8" }).stdout.trim();
      if (!out) continue;
      // ps prints [[dd-]hh:]mm:ss
      const parts = out.split(/[-:]/).map(Number).reverse();
      total += (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600 + (parts[3] ?? 0) * 86400;
    }
    return total;
  }
}

export function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  // With n <= 20 a "p95" is just the maximum, which reads as a tail figure
  // while being a single sample. Reported as such.
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    // max/min. The measuring machine is often running the very agent load
    // under study, so this says whether a timing figure can be believed at
    // all. Above 2 means repeat the run on an idle machine.
    noise: sorted[sorted.length - 1] / Math.max(sorted[0], 0.0001),
  };
}

export function fmtMs(ms) {
  return `${ms.toFixed(1)}ms`;
}
