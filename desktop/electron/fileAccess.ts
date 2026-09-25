import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { shell } from "electron";

import { archcarBinary } from "./archcar";

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
export async function restartDaemon(): Promise<FileAccessResult> {
  if (process.platform !== "darwin") return { ok: false, error: "macOS only" };
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  try {
    await execFileAsync("launchctl", restartArgs(uid));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `${(err as Error).message} — quit and reopen Archductor to restart the daemon.`,
    };
  }
}
