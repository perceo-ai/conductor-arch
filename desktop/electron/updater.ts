// Auto-update policy, kept out of main.ts so every decision here is testable
// without an Electron runtime.
//
// Whether an install can happen in place depends entirely on how the app was
// installed, and that varies per platform:
//
//   Windows (nsis)       download + relaunch, unsigned is fine
//   Linux AppImage       download + relaunch; only when launched AS the
//                        AppImage, which is what $APPIMAGE tells us
//   Linux deb/rpm        owned by the system package manager — electron-updater
//                        cannot replace those files
//   macOS (dmg)          Squirrel.Mac refuses an unsigned/unnotarized bundle,
//                        and this app is not signed yet
//
// The two cases that cannot self-install still tell the user a release exists;
// their button opens the release page instead.

/** How the Update button behaves, or that updating is off entirely. */
export type UpdateMode = "install" | "open" | "disabled";

export interface UpdateModeInput {
  platform: NodeJS.Platform;
  /** `app.isPackaged` — a dev run must never try to replace itself. */
  packaged: boolean;
  env: Record<string, string | undefined>;
}

export function updateMode({ platform, packaged, env }: UpdateModeInput): UpdateMode {
  if (!packaged) return "disabled";
  if (platform === "win32") return "install";
  if (platform === "linux") return env.APPIMAGE ? "install" : "open";
  // darwin and anything unexpected: tell, don't install.
  return "open";
}

export function normalizeVersion(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

export function compareVersions(left: string, right: string): number {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type UpdateCheckResult =
  | { ok: true; currentVersion: string; latestVersion?: string; updateAvailable: boolean; releaseUrl?: string }
  | { ok: false; currentVersion: string; error: string };

const LATEST_RELEASE_API = "https://api.github.com/repos/perceo-ai/conductor-arch/releases/latest";

/** The GitHub-API half of the check: used by `open` mode and by the manual
 *  "Check for updates" button in Settings. */
export async function checkLatestRelease(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateCheckResult> {
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Archductor/${currentVersion}`,
      },
    });
    if (!response.ok) {
      return { ok: false, currentVersion, error: `GitHub returned ${response.status}` };
    }
    const release = (await response.json()) as { tag_name?: string; html_url?: string };
    const latestVersion = release.tag_name?.trim();
    if (!latestVersion) return { ok: false, currentVersion, error: "latest release has no tag" };
    return {
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: release.html_url,
    };
  } catch (err) {
    return { ok: false, currentVersion, error: (err as Error).message };
  }
}

/** What the renderer is told once a new version is ready to act on. */
export interface UpdateReady {
  version: string;
  /** `install` = restart applies it; `open` = send them to the download page. */
  mode: Exclude<UpdateMode, "disabled">;
  releaseUrl?: string;
}

export interface ScheduleOptions {
  /** Delay before the first check, so startup is not competing with a fetch. */
  initialDelayMs: number;
  intervalMs: number;
  run: () => void;
  setTimeoutImpl?: typeof setTimeout;
  setIntervalImpl?: typeof setInterval;
  clearTimeoutImpl?: typeof clearTimeout;
  clearIntervalImpl?: typeof clearInterval;
}

/** Run `run` shortly after startup and then every `intervalMs`. Returns a
 *  cancel function so a quitting app leaves no timer behind. */
export function scheduleUpdateChecks({
  initialDelayMs,
  intervalMs,
  run,
  setTimeoutImpl = setTimeout,
  setIntervalImpl = setInterval,
  clearTimeoutImpl = clearTimeout,
  clearIntervalImpl = clearInterval,
}: ScheduleOptions): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  const timeout = setTimeoutImpl(() => {
    run();
    interval = setIntervalImpl(run, intervalMs);
  }, initialDelayMs);
  return () => {
    clearTimeoutImpl(timeout);
    if (interval) clearIntervalImpl(interval);
  };
}
