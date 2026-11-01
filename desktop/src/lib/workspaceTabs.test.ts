// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  activeWorkspace,
  closeTab,
  emptyTabs,
  focusGroup,
  moveTab,
  openTab,
  renameTab,
  retainTabs,
  splitTab,
  type WorkspaceTabsState,
} from "./workspaceTabs";

function open(...names: string[]): WorkspaceTabsState {
  return names.reduce(openTab, emptyTabs());
}

function shape(state: WorkspaceTabsState) {
  return {
    groups: state.groups.map((group) => ({ tabs: group.tabs, active: group.active })),
    focused: state.focused,
  };
}

describe("openTab", () => {
  it("adds a new workspace after the active tab and activates it", () => {
    const state = openTab(focusTab(open("a", "b", "c"), "a"), "d");
    expect(shape(state)).toEqual({ groups: [{ tabs: ["a", "d", "b", "c"], active: "d" }], focused: 0 });
  });

  it("focuses an already-open tab instead of duplicating it", () => {
    const state = openTab(open("a", "b"), "a");
    expect(shape(state)).toEqual({ groups: [{ tabs: ["a", "b"], active: "a" }], focused: 0 });
  });

  it("focuses the other group when the workspace already lives there", () => {
    const split = splitTab(open("a", "b"), "b", "right");
    const state = openTab(focusGroup(split, 0), "b");
    expect(state.focused).toBe(1);
    expect(activeWorkspace(state)).toBe("b");
  });
});

function focusTab(state: WorkspaceTabsState, name: string) {
  return openTab(state, name);
}

describe("closeTab", () => {
  it("activates the next tab, or the previous one at the end", () => {
    expect(activeWorkspace(closeTab(focusTab(open("a", "b", "c"), "b"), "b"))).toBe("c");
    expect(activeWorkspace(closeTab(open("a", "b", "c"), "c"))).toBe("b");
  });

  it("keeps the active tab when an inactive one closes", () => {
    expect(activeWorkspace(closeTab(open("a", "b", "c"), "a"))).toBe("c");
  });

  it("leaves no active workspace once the last tab closes", () => {
    const state = closeTab(open("a"), "a");
    expect(shape(state)).toEqual({ groups: [{ tabs: [], active: null }], focused: 0 });
  });

  it("collapses the split when a group's last tab closes", () => {
    const split = splitTab(open("a", "b"), "b", "down");
    const state = closeTab(split, "b");
    expect(shape(state)).toEqual({ groups: [{ tabs: ["a"], active: "a" }], focused: 0 });
  });

  it("collapses onto the second group when the first group empties", () => {
    const split = splitTab(open("a", "b"), "b", "right");
    const state = closeTab(split, "a");
    expect(shape(state)).toEqual({ groups: [{ tabs: ["b"], active: "b" }], focused: 0 });
  });

  it("ignores a workspace that is not open", () => {
    const state = open("a");
    expect(closeTab(state, "zzz")).toBe(state);
  });
});

describe("splitTab", () => {
  it("moves the tab into a new group, focuses it, and records the direction", () => {
    const state = splitTab(open("a", "b", "c"), "b", "down");
    expect(shape(state)).toEqual({
      groups: [
        { tabs: ["a", "c"], active: "c" },
        { tabs: ["b"], active: "b" },
      ],
      focused: 1,
    });
    expect(state.direction).toBe("down");
  });

  it("refuses to split off a group's only tab", () => {
    const state = open("a");
    expect(splitTab(state, "a", "right")).toBe(state);
  });

  it("never makes a third group: with two groups it moves the tab across", () => {
    const split = splitTab(open("a", "b", "c"), "c", "right");
    const state = splitTab(split, "a", "right");
    expect(shape(state)).toEqual({
      groups: [
        { tabs: ["b"], active: "b" },
        { tabs: ["c", "a"], active: "a" },
      ],
      focused: 1,
    });
  });

  it("gives the new group a fresh id so it renders as its own pane", () => {
    const state = splitTab(open("a", "b"), "b", "right");
    expect(state.groups[0].id).not.toBe(state.groups[1].id);
  });
});

describe("moveTab", () => {
  it("reorders a tab within its group", () => {
    const state = moveTab(open("a", "b", "c"), "c", 0, 0);
    expect(state.groups[0].tabs).toEqual(["c", "a", "b"]);
  });

  it("moves a tab between groups at the drop index and focuses the target", () => {
    const split = splitTab(open("a", "b", "c"), "c", "right");
    const state = moveTab(focusGroup(split, 0), "a", 1, 0);
    expect(shape(state)).toEqual({
      groups: [
        { tabs: ["b"], active: "b" },
        { tabs: ["a", "c"], active: "a" },
      ],
      focused: 1,
    });
  });

  it("collapses the source group when its last tab moves out", () => {
    const split = splitTab(open("a", "b"), "b", "right");
    const state = moveTab(split, "b", 0, 2);
    expect(shape(state)).toEqual({ groups: [{ tabs: ["a", "b"], active: "b" }], focused: 0 });
  });
});

describe("renameTab and retainTabs", () => {
  it("renames a tab in place and keeps it active", () => {
    const state = renameTab(open("a", "b"), "b", "beta");
    expect(shape(state)).toEqual({ groups: [{ tabs: ["a", "beta"], active: "beta" }], focused: 0 });
  });

  it("drops tabs for workspaces that no longer exist and collapses empty groups", () => {
    const split = splitTab(open("a", "b", "c"), "c", "right");
    const state = retainTabs(split, (name) => name !== "c");
    expect(shape(state)).toEqual({ groups: [{ tabs: ["a", "b"], active: "b" }], focused: 0 });
  });

  it("returns the same state when nothing is dropped", () => {
    const state = open("a", "b");
    expect(retainTabs(state, () => true)).toBe(state);
  });
});
