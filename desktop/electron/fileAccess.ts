import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { shell } from "electron";

import { archcarBinary, killSpawnedDaemon } from "./archcar";

const execFileAsync = promisify(execFile);

/** Mirrors `SERVICE_LABEL` in crates/core/src/service.rs. */
const SERVICE_LABEL = "ai.perceo.archductor.archcar";

/**
 * macOS cannot be asked for Full Disk Access programmatically — the pane is the
 * only route, so the deep link is the closest thing to a prompt there is.
 */
export const FULL_DISK_ACCESS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/** `launchctl` arguments that restart the agent so it re-reads its grants. */
export function restartArgs(uid: number): string[] {
  return ["kickstart", "-k", `gui/${uid}/${SERVICE_LABEL}`];
}

export type FileAccessResult = { ok: boolean; error?: string };

export async function openSettings(): Promise<FileAccessResult> {
  try {
    await shell.openExternal(FULL_DISK_ACCESS_URL);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Reveal the daemon binary so the user can drag it into the pane. */
export function revealDaemon(): FileAccessResult {
  try {
    shell.showItemInFolder(archcarBinary());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * A granted permission only reaches a running process on restart. When a
 * launchd unit owns the daemon, kickstart it; otherwise the daemon is the child
 * this app spawned, and killing it is enough — the next request re-spawns it.
 */
/** Runs a command; the seam the restart path is tested through. */
export type CommandRunner = (command: string, args: string[]) => Promise<unknown>;

const runCommand: CommandRunner = (command, args) => execFileAsync(command, args);

export async function restartDaemon(
  run: CommandRunner = runCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<FileAccessResult> {
  // The platform is a parameter so both branches stay testable on any host.
  // These tests run on Linux in the release workflow, where a darwin-only
  // function would otherwise assert nothing at all.
  if (platform !== "darwin") return { ok: false, error: "macOS only" };
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid < 0) return { ok: false, error: "cannot determine the launchd user domain" };
  try {
    await run("launchctl", restartArgs(uid));
    return { ok: true };
  } catch (err) {
    // No launchd unit is the ordinary case: the daemon is then the child this
    // app spawned, which launchctl knows nothing about. Killing it is the
    // restart — the next request spawns a fresh one that re-reads its grants.
    if (killSpawnedDaemon()) return { ok: true };
    return {
      ok: false,
      error: `${(err as Error).message} — quit and reopen Archductor to restart the daemon.`,
    };
  }
}
