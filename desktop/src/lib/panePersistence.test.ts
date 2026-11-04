// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPaneRealm,
  materializePanes,
  savePaneRealm,
  serializePanes,
  type PersistedPanes,
} from "./panePersistence";
import { emptyPanes, openWorkspace, splitWorkspace } from "./workspacePanes";

// Node 22 ships its own (broken) localStorage global; give the module a real
// in-memory one so reads and writes round-trip.
function stubStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  });
}

function split(): ReturnType<typeof emptyPanes> {
  return splitWorkspace(openWorkspace(emptyPanes(), "a"), "b", "down");
}

describe("serializePanes", () => {
  it("captures panes, focus, direction, and only open workspaces' threads", () => {
    expect(serializePanes(split(), { a: 1, b: 2, closed: 9 })).toEqual({
      panes: [{ workspace: "a" }, { workspace: "b" }],
      focused: 1,
      direction: "down",
      threads: { a: 1, b: 2 },
    });
  });
});

describe("materializePanes", () => {
  it("round-trips a serialized state", () => {
    const { state, threads } = materializePanes(serializePanes(split(), { a: 1 }), () => true);
    expect(state.panes.map((pane) => pane.workspace)).toEqual(["a", "b"]);
    expect(state.focused).toBe(1);
    expect(state.direction).toBe("down");
    expect(threads).toEqual({ a: 1 });
    expect(state.panes[0].id).not.toBe(state.panes[1].id);
  });

  it("drops workspaces that no longer exist, with their threads", () => {
    const { state, threads } = materializePanes(serializePanes(split(), { a: 1, b: 2 }), (name) => name !== "b");
    expect(state.panes.map((pane) => pane.workspace)).toEqual(["a"]);
    expect(state.focused).toBe(0);
    expect(threads).toEqual({ a: 1 });
  });

  it("returns empty state for null, an emptied entry, or garbage fields", () => {
    expect(materializePanes(null, () => true).state.panes[0].workspace).toBeNull();
    expect(materializePanes(serializePanes(split(), {}), () => false).state.panes[0].workspace).toBeNull();
    const garbage = {
      panes: [{ workspace: "a" }, { workspace: "a" }, { workspace: 7 as unknown as string }],
      focused: 99,
      direction: "sideways" as never,
      threads: { a: "x" as unknown as number },
    } satisfies PersistedPanes;
    const { state, threads } = materializePanes(garbage, () => true);
    expect(state.panes.map((pane) => pane.workspace)).toEqual(["a"]);
    expect(state.focused).toBe(0);
    expect(state.direction).toBe("right");
    expect(threads).toEqual({});
  });
});

describe("storage realms", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    stubStorage();
  });

  it("keeps one entry per realm and survives unknown realms", () => {
    savePaneRealm("local", serializePanes(openWorkspace(emptyPanes(), "a"), { a: 1 }));
    savePaneRealm("client:x", serializePanes(openWorkspace(emptyPanes(), "other"), {}));
    expect(loadPaneRealm("local")?.panes).toEqual([{ workspace: "a" }]);
    expect(loadPaneRealm("client:x")?.panes).toEqual([{ workspace: "other" }]);
    expect(loadPaneRealm("client:gone")).toBeNull();
  });

  it("treats corrupt storage as empty", () => {
    localStorage.setItem("archductor.workspacePanes.v2", "{not json");
    expect(loadPaneRealm("local")).toBeNull();
    // And a save over it recovers.
    savePaneRealm("local", serializePanes(openWorkspace(emptyPanes(), "a"), {}));
    expect(loadPaneRealm("local")?.panes).toEqual([{ workspace: "a" }]);
  });

  it("migrates a tab-strip entry: each pane keeps the tab it had active", () => {
    localStorage.setItem(
      "archductor.workspaceTabs.v1",
      JSON.stringify({
        local: {
          groups: [
            { tabs: ["a", "b"], active: "b" },
            { tabs: ["c"], active: "c" },
          ],
          focused: 1,
          direction: "down",
          threads: { b: 2, c: 3 },
        },
      }),
    );
    const migrated = loadPaneRealm("local")!;
    expect(migrated.panes).toEqual([{ workspace: "b" }, { workspace: "c" }]);
    expect(migrated.focused).toBe(1);
    expect(migrated.direction).toBe("down");
    expect(migrated.threads).toEqual({ b: 2, c: 3 });

    // A v2 entry, once written, wins over the legacy one.
    savePaneRealm("local", serializePanes(openWorkspace(emptyPanes(), "z"), {}));
    expect(loadPaneRealm("local")?.panes).toEqual([{ workspace: "z" }]);
  });

  it("falls back to a group's first tab when its active tab is bogus", () => {
    localStorage.setItem(
      "archductor.workspaceTabs.v1",
      JSON.stringify({ local: { groups: [{ tabs: ["a", "b"], active: "gone" }] } }),
    );
    expect(loadPaneRealm("local")?.panes).toEqual([{ workspace: "a" }]);
  });
});
