// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { prefsStore, repositoriesStore, workspacesStore } from "@/store";
import type { RepositoryRow, WorkspaceRow } from "@/store";
import { sidebarWorkspaceOrder } from "@/lib/sidebarWorkspaces";
import { shortcutForAction, type ShortcutAction } from "@/lib/shortcuts";
import Sidebar, { workspaceSlotMap } from "./Sidebar";

// The real order function behind a counter: the memo's whole claim is how often
// this runs, and the numbers below only mean something if it still does the work.
vi.mock("@/lib/sidebarWorkspaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sidebarWorkspaces")>();
  return { ...actual, sidebarWorkspaceOrder: vi.fn(actual.sidebarWorkspaceOrder) };
});

vi.mock("@/bridge/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/bridge/client")>()),
  repoAvatar: async () => ({ ok: false }),
}));

const orderCalls = vi.mocked(sidebarWorkspaceOrder);

function repository(name: string, id: number): RepositoryRow {
  return {
    id,
    name,
    rootPath: `/tmp/${name}`,
    defaultBranch: "main",
    remoteName: "origin",
    activeWorkspaces: 0,
    totalWorkspaces: 0,
  };
}

function workspace(name: string, repo: string, id: number): WorkspaceRow {
  return {
    id,
    name,
    path: `/tmp/${repo}/${name}`,
    branch: name,
    baseRef: "main",
    status: "active",
    repository: repo,
    additions: 0,
    deletions: 0,
    openTodos: 0,
    openTasks: 0,
    blockedTasks: 0,
    activeSessions: 0,
    awaitingInput: false,
    runRunning: false,
    changedFiles: 0,
    updatedAt: "2026-11-06T00:00:00Z",
  };
}

const REPOSITORIES = ["alpha", "beta", "gamma"].map(repository);

// Interleaved on purpose: the daemon's order is not the sidebar's, so a slot
// counted down the raw order would be caught here.
const WORKSPACES = [
  ["a1", "alpha"], ["b1", "beta"], ["c1", "gamma"], ["a2", "alpha"],
  ["b2", "beta"], ["c2", "gamma"], ["a3", "alpha"], ["b3", "beta"],
  ["c3", "gamma"], ["a4", "alpha"], ["b4", "beta"], ["c4", "gamma"],
].map(([name, repo], id) => workspace(name, repo, id));

function appOrder(): string[] {
  return sidebarWorkspaceOrder(
    repositoriesStore.state.order,
    workspacesStore.state.order,
    (name) => workspacesStore.row(name),
    (name) => prefsStore.isPinned(name),
  );
}

/** Where `selectWorkspaceSlot` in App.tsx sends `switch-workspace-N`. */
function appTarget(n: number): string | undefined {
  return appOrder()[n - 1];
}

function slotAction(n: number): ShortcutAction {
  return `switch-workspace-${n}` as ShortcutAction;
}

function assertParity(slots: Map<string, ShortcutAction>) {
  for (let n = 1; n <= 9; n += 1) {
    const named = [...slots].find(([, action]) => action === slotAction(n))?.[0];
    expect(named, `switch-workspace-${n}`).toBe(appTarget(n));
  }
}

/** Workspace name -> the hint its row is showing right now, in DOM order. */
function renderedHints(): Map<string, string | undefined> {
  const rows = document.querySelectorAll<HTMLElement>(".workspace-row-shell");
  return new Map(
    [...rows].map((row) => [
      row.querySelector(".row-name")?.getAttribute("title") ?? "",
      row.dataset.shortcut,
    ]),
  );
}

function renderedSlot(name: string): number | undefined {
  const hint = renderedHints().get(name);
  if (hint === undefined) return undefined;
  for (let n = 1; n <= 9; n += 1) {
    if (shortcutForAction(slotAction(n)) === hint) return n;
  }
  throw new Error(`${name} shows ${hint}, which is no workspace slot`);
}

let dispose: (() => void) | undefined;
let rowElements: Map<string, Element>;

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <Sidebar collapsed={false} onToggle={() => {}} />, host);
  rowElements = new Map(
    [...document.querySelectorAll(".workspace-row-shell")].map((row) => [
      row.querySelector(".row-name")?.getAttribute("title") ?? "",
      row,
    ]),
  );
}

/** Same DOM node as at mount: the hint moved on a live row, not a rebuilt one. */
function expectSameRow(name: string) {
  expect(document.body.contains(rowElements.get(name)!)).toBe(true);
}

beforeEach(() => {
  repositoriesStore.setAll(REPOSITORIES);
  workspacesStore.setAll(WORKSPACES);
  orderCalls.mockClear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  for (const name of [...prefsStore.state.pinnedWorkspaces]) prefsStore.togglePinned(name);
  repositoriesStore.setAll([]);
  workspacesStore.setAll([]);
});

describe("sidebar hotkey slots: how often the order is computed", () => {
  it("does not walk the order per row when the sidebar mounts", () => {
    mount();
    expect(renderedHints().size).toBe(WORKSPACES.length);
    expect(orderCalls).toHaveBeenCalledTimes(0);
  });

  it("walks the order once for all rows when a pin changes", () => {
    mount();
    prefsStore.togglePinned("c4");
    expect(orderCalls).toHaveBeenCalledTimes(1);
  });

  it("walks the order once for all rows when repositories reorder", () => {
    mount();
    repositoriesStore.setAll([...REPOSITORIES].reverse());
    expect(orderCalls).toHaveBeenCalledTimes(1);
  });

  it("leaves the order alone when a row changes a field the order does not read", () => {
    mount();
    workspacesStore.patch("a1", { additions: 12, activeSessions: 2 });
    expect(orderCalls).toHaveBeenCalledTimes(0);
  });
});

describe("sidebar hotkey slots: parity with App.tsx", () => {
  beforeEach(() => {
    prefsStore.togglePinned("a3");
    prefsStore.togglePinned("c2");
  });

  it("names the workspace App.tsx selects for every slot", () => {
    assertParity(workspaceSlotMap(appOrder()));
  });

  it("shows each slot's hint on the row App.tsx selects", () => {
    mount();
    const hints = renderedHints();
    for (let n = 1; n <= 9; n += 1) {
      expect(hints.get(appTarget(n)!)).toBe(shortcutForAction(slotAction(n)));
    }
    expect([...hints.values()].filter(Boolean)).toHaveLength(9);
  });

  it("gives the tenth row onward no slot", () => {
    const order = appOrder();
    const slots = workspaceSlotMap(order);
    expect(slots.size).toBe(9);
    expect(order.slice(9).some((name) => slots.has(name))).toBe(false);
  });

  it("fails the parity check on a map built before a pin changed", () => {
    const stale = workspaceSlotMap(appOrder());
    prefsStore.togglePinned("b4");
    expect(() => assertParity(stale)).toThrow();
    assertParity(workspaceSlotMap(appOrder()));
  });

  it("fails the parity check on a map one slot out", () => {
    const shifted = workspaceSlotMap(["ghost", ...appOrder()]);
    expect(() => assertParity(shifted)).toThrow();
  });

  it("keeps a repeated name on its first slot, as indexOf did", () => {
    const slots = workspaceSlotMap(["x", "y", "x"]);
    expect(slots.get("x")).toBe(slotAction(1));
    expect(slots.get("y")).toBe(slotAction(2));
  });
});

describe("sidebar hotkey slots: updates without a remount", () => {
  it("moves a workspace forward when it is pinned", () => {
    mount();
    expect(renderedSlot("a4")).toBe(4);
    expect(renderedSlot("a1")).toBe(1);
    prefsStore.togglePinned("a4");
    expect(renderedSlot("a4")).toBe(1);
    expect(renderedSlot("a1")).toBe(2);
    expectSameRow("a1");
  });

  it("moves a workspace back when it is unpinned", () => {
    prefsStore.togglePinned("a4");
    mount();
    expect(renderedSlot("a4")).toBe(1);
    prefsStore.togglePinned("a4");
    expect(renderedSlot("a4")).toBe(4);
    expect(renderedSlot("a1")).toBe(1);
    expectSameRow("a1");
  });

  it("moves a repository's block of slots when repositories reorder", () => {
    mount();
    expect(["a1", "b1", "c1"].map(renderedSlot)).toEqual([1, 5, 9]);
    repositoriesStore.setAll([...REPOSITORIES].reverse());
    expect(["c1", "b1", "a1"].map(renderedSlot)).toEqual([1, 5, 9]);
    expect(renderedSlot("c4")).toBe(4);
    expect(renderedSlot("a2")).toBeUndefined();
  });

  it("adds a workspace without disturbing earlier slots", () => {
    mount();
    const before = ["a1", "a2", "a3", "a4"].map(renderedSlot);
    workspacesStore.setAll([...WORKSPACES, workspace("a5", "alpha", 100)]);
    expect(["a1", "a2", "a3", "a4"].map(renderedSlot)).toEqual(before);
    expect(renderedSlot("a5")).toBe(5);
    expect(renderedSlot("b1")).toBe(6);
  });

  it("adds a pinned workspace ahead of the others", () => {
    prefsStore.togglePinned("a5");
    mount();
    workspacesStore.setAll([...WORKSPACES, workspace("a5", "alpha", 100)]);
    expect(["a5", "a1", "a2"].map(renderedSlot)).toEqual([1, 2, 3]);
  });

  it("closes the gap when a workspace is archived", () => {
    mount();
    workspacesStore.patch("a1", { status: "archived" });
    expect(renderedSlot("a2")).toBe(1);
  });
});
