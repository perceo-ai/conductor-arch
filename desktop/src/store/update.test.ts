import { beforeEach, describe, expect, it, vi } from "vitest";

// Node 22 exposes a half-configured global `localStorage` that throws on use,
// and it shadows jsdom's. Give the store a real one.
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
});

const installUpdate = vi.fn(async () => ({ ok: true }));

vi.mock("@/bridge/client", () => ({
  installUpdate: () => installUpdate(),
  onUpdateReady: () => () => {},
  updateState: async () => null,
}));

const { allAgentsStopped, shouldOfferUpdate, updateStore, updateToastCopy } = await import(
  "./update"
);
const { toastsStore } = await import("./toasts");
const { workspacesStore } = await import("./workspaces");

function row(name: string, over: { activeSessions?: number; runRunning?: boolean } = {}) {
  return {
    id: 1,
    name,
    path: `/tmp/${name}`,
    branch: name,
    baseRef: "main",
    status: "active",
    repository: "repo",
    additions: 0,
    deletions: 0,
    openTodos: 0,
    openTasks: 0,
    blockedTasks: 0,
    activeSessions: over.activeSessions ?? 0,
    awaitingInput: false,
    runRunning: over.runRunning ?? false,
    changedFiles: 0,
    updatedAt: "0",
  };
}

/** Toasts on their way out stay mounted for the exit animation; only live ones
 *  are what a user would see. */
function liveToasts() {
  return toastsStore.state.items.filter((toast) => !toast.leaving);
}

beforeEach(() => {
  installUpdate.mockClear();
  // Clear the stack before the storage: dismissing a leftover toast records a
  // dismissal, which would otherwise suppress the next test's offer.
  for (const toast of [...toastsStore.state.items]) toastsStore.dismiss(toast.id);
  storage.clear();
  updateStore.resetForTests();
  workspacesStore.setAll([]);
});

describe("allAgentsStopped", () => {
  it("is true only when no workspace has a session or a run script going", () => {
    expect(allAgentsStopped([])).toBe(true);
    expect(allAgentsStopped([row("a"), row("b")])).toBe(true);
    expect(allAgentsStopped([row("a"), row("b", { activeSessions: 1 })])).toBe(false);
    // A run script counts too — restarting mid-run kills it.
    expect(allAgentsStopped([row("a", { runRunning: true })])).toBe(false);
  });
});

describe("shouldOfferUpdate", () => {
  const ready = { version: "v0.7.0", mode: "install" as const };

  it("offers once, only while idle, and never for an answered version", () => {
    expect(
      shouldOfferUpdate({
        ready,
        inventoryLoaded: true,
        agentsStopped: true,
        dismissedVersion: null,
        offeredVersion: null,
      }),
    ).toBe(true);
    expect(
      shouldOfferUpdate({
        ready,
        inventoryLoaded: true,
        agentsStopped: false,
        dismissedVersion: null,
        offeredVersion: null,
      }),
    ).toBe(false);
    expect(
      shouldOfferUpdate({
        ready,
        inventoryLoaded: true,
        agentsStopped: true,
        dismissedVersion: "v0.7.0",
        offeredVersion: null,
      }),
    ).toBe(false);
    expect(
      shouldOfferUpdate({
        ready,
        inventoryLoaded: true,
        agentsStopped: true,
        dismissedVersion: null,
        offeredVersion: "v0.7.0",
      }),
    ).toBe(false);
    expect(
      shouldOfferUpdate({
        ready: null,
        inventoryLoaded: true,
        agentsStopped: true,
        dismissedVersion: null,
        offeredVersion: null,
      }),
    ).toBe(false);
  });

  it("waits for the first inventory load — an empty store is not proof of idleness", () => {
    // Regression: at mount the store is empty, which read as "all agents
    // stopped", so the toast appeared over a workspace with a running agent.
    expect(
      shouldOfferUpdate({
        ready,
        inventoryLoaded: false,
        agentsStopped: true,
        dismissedVersion: null,
        offeredVersion: null,
      }),
    ).toBe(false);
  });

  it("asks again once a newer version arrives", () => {
    expect(
      shouldOfferUpdate({
        ready: { version: "v0.8.0", mode: "install" },
        inventoryLoaded: true,
        agentsStopped: true,
        dismissedVersion: "v0.7.0",
        offeredVersion: "v0.7.0",
      }),
    ).toBe(true);
  });
});

describe("updateToastCopy", () => {
  it("promises a restart only where the app can install itself", () => {
    expect(updateToastCopy({ version: "v0.7.0", mode: "install" }).label).toBe("Restart to update");
    expect(updateToastCopy({ version: "v0.7.0", mode: "open" }).label).toBe("Download");
  });
});

describe("updateStore.evaluate", () => {
  it("stays quiet while an agent is running, then offers when it stops", () => {
    workspacesStore.setAll([row("busy", { activeSessions: 1 })]);
    updateStore.setReadyForTests({ version: "v0.7.0", mode: "install" });

    updateStore.evaluate();
    expect(liveToasts()).toHaveLength(0);

    workspacesStore.setAll([row("busy")]);
    updateStore.evaluate();
    expect(liveToasts()).toHaveLength(1);
    expect(liveToasts()[0].message).toContain("v0.7.0");
    expect(liveToasts()[0].action?.label).toBe("Restart to update");
  });

  it("pushes one toast per version however often it is evaluated", () => {
    workspacesStore.setAll([]);
    updateStore.setReadyForTests({ version: "v0.7.0", mode: "install" });
    updateStore.evaluate();
    updateStore.evaluate();
    updateStore.evaluate();
    expect(liveToasts()).toHaveLength(1);
  });

  it("does not auto-expire — an unanswered update stays on screen", () => {
    vi.useFakeTimers();
    try {
      updateStore.setReadyForTests({ version: "v0.7.0", mode: "install" });
      updateStore.evaluate();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(liveToasts()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs on click and does not re-offer a dismissed version", () => {
    updateStore.setReadyForTests({ version: "v0.7.0", mode: "install" });
    updateStore.evaluate();

    const toast = liveToasts()[0];
    toast.action?.run();
    toastsStore.dismiss(toast.id);
    expect(installUpdate).toHaveBeenCalledTimes(1);

    // A fresh run (offeredVersion forgotten) must still respect the dismissal.
    const remembered = localStorage.getItem("archductor.update.dismissed.v1");
    expect(remembered).toBe("v0.7.0");
    expect(
      shouldOfferUpdate({
        ready: { version: "v0.7.0", mode: "install" },
        inventoryLoaded: true,
        agentsStopped: true,
        dismissedVersion: remembered,
        offeredVersion: null,
      }),
    ).toBe(false);
  });

  it("remembers a close-button dismissal too", () => {
    updateStore.setReadyForTests({ version: "v0.7.0", mode: "open" });
    updateStore.evaluate();
    toastsStore.dismiss(liveToasts()[0].id);
    expect(installUpdate).not.toHaveBeenCalled();
    expect(localStorage.getItem("archductor.update.dismissed.v1")).toBe("v0.7.0");
  });
});
