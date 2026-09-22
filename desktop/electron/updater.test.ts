// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  checkLatestRelease,
  compareVersions,
  scheduleUpdateChecks,
  shouldFallBackToOpen,
  updateMode,
} from "./updater";

describe("updateMode", () => {
  it("never updates a dev run", () => {
    for (const platform of ["win32", "linux", "darwin"] as NodeJS.Platform[]) {
      expect(updateMode({ platform, packaged: false, env: { APPIMAGE: "/x.AppImage" } })).toBe(
        "disabled",
      );
    }
  });

  it("installs in place on Windows", () => {
    expect(updateMode({ platform: "win32", packaged: true, env: {} })).toBe("install");
  });

  it("installs in place on Linux only when running as an AppImage", () => {
    expect(
      updateMode({ platform: "linux", packaged: true, env: { APPIMAGE: "/opt/a.AppImage" } }),
    ).toBe("install");
    // deb/rpm are owned by the system package manager.
    expect(updateMode({ platform: "linux", packaged: true, env: {} })).toBe("open");
  });

  it("installs in place on macOS now that release builds are signed + notarized", () => {
    expect(updateMode({ platform: "darwin", packaged: true, env: {} })).toBe("install");
  });
});

describe("shouldFallBackToOpen", () => {
  it("demotes a mac build Squirrel rejects for its signature", () => {
    expect(
      shouldFallBackToOpen("darwin", "Could not get code signature for running application"),
    ).toBe(true);
    expect(shouldFallBackToOpen("darwin", "app is not signed")).toBe(true);
  });

  it("keeps retrying install for transient errors and other platforms", () => {
    // Offline / missing feed heal on their own; the next check must retry.
    expect(shouldFallBackToOpen("darwin", "net::ERR_INTERNET_DISCONNECTED")).toBe(false);
    expect(shouldFallBackToOpen("darwin", "Cannot find latest-mac.yml")).toBe(false);
    expect(shouldFallBackToOpen("win32", "signature verification failed")).toBe(false);
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexically, and tolerates a leading v", () => {
    expect(compareVersions("v0.10.0", "v0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.6.2", "v0.6.2")).toBe(0);
    expect(compareVersions("v0.6.2", "0.7.0")).toBeLessThan(0);
  });
});

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("checkLatestRelease", () => {
  it("reports a newer release as available", async () => {
    const result = await checkLatestRelease(
      "0.6.2",
      fakeFetch({ tag_name: "v0.7.0", html_url: "https://gh/releases/v0.7.0" }),
    );
    expect(result).toEqual({
      ok: true,
      currentVersion: "0.6.2",
      latestVersion: "v0.7.0",
      updateAvailable: true,
      releaseUrl: "https://gh/releases/v0.7.0",
    });
  });

  it("reports the current release as not available", async () => {
    const result = await checkLatestRelease("0.7.0", fakeFetch({ tag_name: "v0.7.0" }));
    expect(result).toMatchObject({ ok: true, updateAvailable: false });
  });

  it("turns an HTTP error, a missing tag, and a network failure into ok:false", async () => {
    expect(await checkLatestRelease("0.6.2", fakeFetch({}, { ok: false, status: 403 }))).toEqual({
      ok: false,
      currentVersion: "0.6.2",
      error: "GitHub returned 403",
    });

    expect(await checkLatestRelease("0.6.2", fakeFetch({ tag_name: "  " }))).toMatchObject({
      ok: false,
      error: "latest release has no tag",
    });

    const throwing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await checkLatestRelease("0.6.2", throwing)).toMatchObject({
      ok: false,
      error: "offline",
    });
  });
});

describe("scheduleUpdateChecks", () => {
  it("runs after the initial delay and then on the interval, and stops when cancelled", () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const cancel = scheduleUpdateChecks({ initialDelayMs: 10_000, intervalMs: 60_000, run });

      vi.advanceTimersByTime(9_999);
      expect(run).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(run).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(120_000);
      expect(run).toHaveBeenCalledTimes(3);

      cancel();
      vi.advanceTimersByTime(600_000);
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no timer behind when cancelled before the first run", () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      scheduleUpdateChecks({ initialDelayMs: 10_000, intervalMs: 60_000, run })();
      vi.advanceTimersByTime(600_000);
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
