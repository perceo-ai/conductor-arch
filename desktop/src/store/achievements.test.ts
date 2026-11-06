import { describe, expect, it, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@/bridge/client", () => ({
  send: (...args: unknown[]) => send(...args),
}));

const { achievementsStore } = await import("./achievements");
const { bumpDaemonEpoch } = await import("./daemonEpoch");

function summary(unlocked: number) {
  return {
    type: "achievements",
    summary: {
      achievements: [
        {
          id: "worktree_wrangler",
          name: "Worktree Wrangler",
          description: "d",
          category: "Workspaces",
          counts: "c",
          metric: "workspaces_created",
          kind: "lifetime",
          value: 7,
          tier: 1,
          tier_name: "Copper",
          next_threshold: 25,
          tier_thresholds: [5, 25, 100, 400, 1500],
          secret: false,
        },
      ],
      discovery: { total: 200, discovered: 3, names: [] },
      metrics: { workspaces_created: 7 },
      unlocked,
      tiers_earned: 1,
      total: 1,
    },
  };
}

describe("achievementsStore", () => {
  beforeEach(() => {
    achievementsStore.reset();
    send.mockReset();
    send.mockResolvedValue(summary(1));
  });

  it("loads the summary from the daemon", async () => {
    await achievementsStore.load();
    expect(send).toHaveBeenCalledWith({ type: "get_achievements" });
    expect(achievementsStore.summary()?.unlocked).toBe(1);
    expect(achievementsStore.error()).toBeUndefined();
  });

  it("serves a fresh summary from cache instead of re-querying", async () => {
    await achievementsStore.load();
    await achievementsStore.load();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refresh re-reads even when the cache is fresh", async () => {
    await achievementsStore.load();
    send.mockResolvedValue(summary(2));
    await achievementsStore.refresh();
    expect(send).toHaveBeenCalledTimes(2);
    expect(achievementsStore.summary()?.unlocked).toBe(2);
  });

  it("shares one request between concurrent callers", async () => {
    await Promise.all([achievementsStore.refresh(), achievementsStore.refresh()]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("surfaces a daemon error without clearing a previous summary", async () => {
    await achievementsStore.load();
    send.mockResolvedValue({ type: "error", message: "no database" });
    await achievementsStore.refresh();
    expect(achievementsStore.error()).toBe("no database");
    expect(achievementsStore.summary()?.unlocked).toBe(1);
  });

  it("fetches the new daemon's summary after a switch inside the freshness window", async () => {
    await achievementsStore.load();
    expect(achievementsStore.summary()?.unlocked).toBe(1);

    bumpDaemonEpoch();
    send.mockResolvedValue(summary(2));
    await achievementsStore.load();

    expect(send).toHaveBeenCalledTimes(2);
    expect(achievementsStore.summary()?.unlocked).toBe(2);
  });

  it("does not join the old daemon's in-flight request after a switch", async () => {
    let answerOldDaemon: (value: unknown) => void = () => undefined;
    send.mockReturnValueOnce(new Promise((resolve) => (answerOldDaemon = resolve)));
    const oldLoad = achievementsStore.load();

    bumpDaemonEpoch();
    let answerNewDaemon: (value: unknown) => void = () => undefined;
    send.mockReturnValueOnce(new Promise((resolve) => (answerNewDaemon = resolve)));
    const newLoad = achievementsStore.load();
    expect(send).toHaveBeenCalledTimes(2);

    // The old daemon answering late neither lands nor ends the new load.
    answerOldDaemon(summary(1));
    await oldLoad;
    expect(achievementsStore.summary()).toBeUndefined();
    expect(achievementsStore.loading()).toBe(true);

    answerNewDaemon(summary(2));
    await newLoad;
    expect(achievementsStore.summary()?.unlocked).toBe(2);
    expect(achievementsStore.loading()).toBe(false);
  });

  it("ignores a failure from the daemon that was switched away from", async () => {
    let failOldDaemon: (reason: Error) => void = () => undefined;
    send.mockReturnValueOnce(new Promise((_, reject) => (failOldDaemon = reject)));
    const oldLoad = achievementsStore.load();

    bumpDaemonEpoch();
    failOldDaemon(new Error("socket closed"));
    await oldLoad;

    expect(achievementsStore.error()).toBeUndefined();
    expect(achievementsStore.loading()).toBe(false);
  });

  it("reports a rejected request as an error rather than throwing", async () => {
    send.mockRejectedValue(new Error("socket closed"));
    await achievementsStore.refresh();
    expect(achievementsStore.error()).toBe("socket closed");
    expect(achievementsStore.loading()).toBe(false);
  });
});
