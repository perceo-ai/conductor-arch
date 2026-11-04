import { describe, expect, it } from "vitest";
import {
  activeWorkspace,
  closePane,
  closeWorkspace,
  emptyPanes,
  focusPane,
  openWorkspace,
  openWorkspaceIn,
  renameWorkspace,
  retainWorkspaces,
  splitWorkspace,
  type WorkspacePanesState,
} from "./workspacePanes";

function shape(state: WorkspacePanesState) {
  return { panes: state.panes.map((pane) => pane.workspace), focused: state.focused };
}

function open(...names: string[]): WorkspacePanesState {
  return names.reduce((state, name) => openWorkspace(state, name), emptyPanes());
}

describe("workspacePanes", () => {
  it("replaces the focused pane's workspace rather than stacking tabs", () => {
    expect(shape(open("alpha", "beta"))).toEqual({ panes: ["beta"], focused: 0 });
    expect(activeWorkspace(open("alpha", "beta"))).toBe("beta");
  });

  it("focuses the pane that already shows a workspace instead of duplicating it", () => {
    const split = splitWorkspace(open("alpha"), "beta", "right");
    expect(shape(openWorkspace(split, "alpha"))).toEqual({ panes: ["alpha", "beta"], focused: 0 });
  });

  it("splits into a second pane and never a third", () => {
    const split = splitWorkspace(open("alpha"), "beta", "right");
    expect(shape(split)).toEqual({ panes: ["alpha", "beta"], focused: 1 });
    // No room for a third: the newcomer lands in the other pane.
    const third = splitWorkspace(split, "gamma", "right");
    expect(shape(third)).toEqual({ panes: ["gamma", "beta"], focused: 0 });
  });

  it("splitting into an empty lone pane just opens there", () => {
    const state = splitWorkspace(emptyPanes(), "alpha", "down");
    expect(shape(state)).toEqual({ panes: ["alpha"], focused: 0 });
    expect(state.direction).toBe("down");
  });

  it("swaps the two panes when a pane's workspace is dropped on the other", () => {
    const split = splitWorkspace(open("alpha"), "beta", "right");
    expect(shape(openWorkspaceIn(split, "beta", 0))).toEqual({ panes: ["beta", "alpha"], focused: 0 });
  });

  it("a drop on the pane that already shows it only moves focus", () => {
    const split = splitWorkspace(open("alpha"), "beta", "right");
    expect(shape(openWorkspaceIn(split, "alpha", 0))).toEqual({ panes: ["alpha", "beta"], focused: 0 });
  });

  it("closes a pane, and empties rather than removes the last one", () => {
    const split = splitWorkspace(open("alpha"), "beta", "right");
    expect(shape(closePane(split, 1))).toEqual({ panes: ["alpha"], focused: 0 });
    expect(shape(closePane(open("alpha"), 0))).toEqual({ panes: [null], focused: 0 });
    expect(shape(closeWorkspace(split, "alpha"))).toEqual({ panes: ["beta"], focused: 0 });
    expect(closeWorkspace(split, "nope")).toBe(split);
  });

  it("keeps focus pointing at a live pane when an earlier one closes", () => {
    const split = splitWorkspace(open("alpha"), "beta", "right");
    expect(shape(closePane(split, 0))).toEqual({ panes: ["beta"], focused: 0 });
  });

  it("follows a rename and ignores one for a workspace it does not hold", () => {
    expect(shape(renameWorkspace(open("alpha"), "alpha", "alpha-2"))).toEqual({
      panes: ["alpha-2"],
      focused: 0,
    });
    const state = open("alpha");
    expect(renameWorkspace(state, "beta", "gamma")).toBe(state);
  });

  it("drops workspaces the inventory no longer has", () => {
    const split = splitWorkspace(open("alpha"), "beta", "right");
    expect(shape(retainWorkspaces(split, (name) => name === "beta"))).toEqual({
      panes: ["beta"],
      focused: 0,
    });
    expect(shape(retainWorkspaces(split, () => false))).toEqual({ panes: [null], focused: 0 });
  });

  it("focusing an absent pane is a no-op", () => {
    const state = open("alpha");
    expect(focusPane(state, 3)).toBe(state);
    expect(focusPane(state, 0)).toBe(state);
  });

  it("keeps a pane's id when its neighbour closes, so it is not remounted", () => {
    const split = splitWorkspace(open("alpha"), "beta", "right");
    const kept = split.panes[1].id;
    expect(closePane(split, 0).panes[0].id).toBe(kept);
  });
});
