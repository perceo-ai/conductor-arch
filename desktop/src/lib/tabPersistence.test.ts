// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadTabRealm,
  materializeTabs,
  saveTabRealm,
  serializeTabs,
  type PersistedTabs,
} from "./tabPersistence";
import { emptyTabs, openTab, splitTab } from "./workspaceTabs";

// Node 22 ships its own (broken) localStorage global; give the module a real
// in-memory one so reads and writes round-trip.
function stubStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  });
}

function split(): ReturnType<typeof emptyTabs> {
  return splitTab(openTab(openTab(emptyTabs(), "a"), "b"), "b", "down");
}

describe("serializeTabs", () => {
  it("captures groups, focus, direction, and only open tabs' threads", () => {
    const data = serializeTabs(split(), { a: 1, b: 2, closed: 9 });
    expect(data).toEqual({
      groups: [
        { tabs: ["a"], active: "a" },
        { tabs: ["b"], active: "b" },
      ],
      focused: 1,
      direction: "down",
      threads: { a: 1, b: 2 },
    });
  });
});

describe("materializeTabs", () => {
  it("round-trips a serialized state", () => {
    const { state, threads } = materializeTabs(serializeTabs(split(), { a: 1 }), () => true);
    expect(state.groups.map((g) => ({ tabs: g.tabs, active: g.active }))).toEqual([
      { tabs: ["a"], active: "a" },
      { tabs: ["b"], active: "b" },
    ]);
    expect(state.focused).toBe(1);
    expect(state.direction).toBe("down");
    expect(threads).toEqual({ a: 1 });
    expect(state.groups[0].id).not.toBe(state.groups[1].id);
  });

  it("drops workspaces that no longer exist, with their threads", () => {
    const data = serializeTabs(splitTab(openTab(openTab(openTab(emptyTabs(), "a"), "b"), "c"), "c", "right"), {
      a: 1,
      c: 3,
    });
    const { state, threads } = materializeTabs(data, (name) => name !== "c");
    expect(state.groups.map((g) => g.tabs)).toEqual([["a", "b"]]);
    expect(state.focused).toBe(0);
    expect(threads).toEqual({ a: 1 });
  });

  it("returns empty state for null, an emptied entry, or garbage fields", () => {
    expect(materializeTabs(null, () => true).state.groups[0].tabs).toEqual([]);
    expect(materializeTabs(serializeTabs(split(), {}), () => false).state.groups[0].tabs).toEqual([]);
    const garbage = {
      groups: [{ tabs: ["a", "a", 7 as unknown as string], active: "zzz" }],
      focused: 99,
      direction: "sideways" as never,
      threads: { a: "x" as unknown as number },
    } satisfies PersistedTabs;
    const { state, threads } = materializeTabs(garbage, () => true);
    expect(state.groups.map((g) => ({ tabs: g.tabs, active: g.active }))).toEqual([
      { tabs: ["a"], active: "a" },
    ]);
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
    saveTabRealm("local", serializeTabs(openTab(emptyTabs(), "a"), { a: 1 }));
    saveTabRealm("client:x", serializeTabs(openTab(emptyTabs(), "other"), {}));
    expect(loadTabRealm("local")?.groups[0].tabs).toEqual(["a"]);
    expect(loadTabRealm("client:x")?.groups[0].tabs).toEqual(["other"]);
    expect(loadTabRealm("client:gone")).toBeNull();
  });

  it("treats corrupt storage as empty", () => {
    localStorage.setItem("archductor.workspaceTabs.v1", "{not json");
    expect(loadTabRealm("local")).toBeNull();
    // And a save over it recovers.
    saveTabRealm("local", serializeTabs(openTab(emptyTabs(), "a"), {}));
    expect(loadTabRealm("local")?.groups[0].tabs).toEqual(["a"]);
  });
});
