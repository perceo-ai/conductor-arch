import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnedPid = vi.fn((): number | null => null);
const killSpawnedDaemon = vi.fn(() => false);

vi.mock("./archcar", () => ({
  archcarBinary: () => "/Applications/x.app/Contents/Resources/bin/archcar",
  spawnedDaemonPid: spawnedPid,
  killSpawnedDaemon,
}));

vi.mock("electron", () => ({ shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() } }));

// launchctl on a machine with no unit installed; never the real binary, which
// on a developer's Mac would restart their actual daemon.
const kickstartFails = vi.fn(async () => {
  throw new Error('Could not find service "ai.perceo.archductor.archcar"');
});

const { FULL_DISK_ACCESS_URL, restartArgs, restartDaemon } = await import("./fileAccess");

// The deep link and the launchctl invocation are the whole contract here: both
// are strings macOS either accepts or silently ignores, so they are pinned.
describe("fileAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deep-links the Full Disk Access pane", () => {
    expect(FULL_DISK_ACCESS_URL).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    );
  });

  it("kickstarts the agent in the user's gui domain", () => {
    expect(restartArgs(501)).toEqual([
      "kickstart",
      "-k",
      "gui/501/ai.perceo.archductor.archcar",
    ]);
  });

  // The spec's common first-run shape is no LaunchAgent at all: the daemon is
  // the child this app spawned. launchctl cannot restart that one, so a failed
  // kickstart must fall through to killing the child rather than telling the
  // user to quit the app.
  it("kills the spawned child when there is no launchd unit", async () => {
    killSpawnedDaemon.mockReturnValueOnce(true);

    const res = await restartDaemon(kickstartFails, "darwin");

    expect(killSpawnedDaemon).toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it("only asks the user to quit when there is nothing it can restart", async () => {
    killSpawnedDaemon.mockReturnValueOnce(false);

    const res = await restartDaemon(kickstartFails, "darwin");

    expect(res.ok).toBe(false);
    expect(res.error).toContain("quit and reopen");
  });

  it("does nothing off macOS, where there is no such permission", async () => {
    const res = await restartDaemon(kickstartFails, "linux");

    expect(res.ok).toBe(false);
    expect(kickstartFails).not.toHaveBeenCalled();
  });
});
