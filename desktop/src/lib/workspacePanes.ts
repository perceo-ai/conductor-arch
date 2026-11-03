// Workspace panes — the split view under the workspace page.
//
// A pane shows exactly one workspace. There is no tab strip and no hidden tab
// list: what a pane holds is what is on screen, and the sidebar is the only
// workspace list. Panes never exceed two — a third would leave each workspace
// too narrow to read, and two keeps the focus model obvious.
//
// Pure functions over plain data: the nav store owns the signal, and these are
// what it calls, so the rules are testable without a renderer.

export type SplitDirection = "right" | "down";

export interface Pane {
  /** Stable for the pane's lifetime, so a pane is not remounted when its neighbour closes. */
  id: number;
  workspace: string | null;
}

export interface WorkspacePanesState {
  panes: Pane[];
  /** Index into `panes` of the pane that keyboard shortcuts and the sidebar act on. */
  focused: number;
  direction: SplitDirection;
}

export const MAX_PANES = 2;

export function emptyPanes(): WorkspacePanesState {
  return { panes: [{ id: 0, workspace: null }], focused: 0, direction: "right" };
}

/** The workspace shown in the focused pane, which is the app's selected workspace. */
export function activeWorkspace(state: WorkspacePanesState): string | null {
  return state.panes[state.focused]?.workspace ?? null;
}

export function paneIndexOf(state: WorkspacePanesState, name: string): number {
  return state.panes.findIndex((pane) => pane.workspace === name);
}

function nextId(state: WorkspacePanesState): number {
  return Math.max(...state.panes.map((pane) => pane.id)) + 1;
}

function replacePane(panes: Pane[], index: number, pane: Pane): Pane[] {
  return panes.map((existing, i) => (i === index ? pane : existing));
}

/**
 * Show `name` in the focused pane, or focus the pane that already has it. A
 * workspace is never in two panes at once: side by side with itself it would
 * fight over one chat selection.
 */
export function openWorkspace(state: WorkspacePanesState, name: string): WorkspacePanesState {
  const at = paneIndexOf(state, name);
  if (at >= 0) return focusPane(state, at);
  return {
    ...state,
    panes: replacePane(state.panes, state.focused, { ...state.panes[state.focused], workspace: name }),
  };
}

/** Show `name` in pane `index` (a drop onto that pane), focusing it there. */
export function openWorkspaceIn(
  state: WorkspacePanesState,
  name: string,
  index: number,
): WorkspacePanesState {
  if (!state.panes[index]) return state;
  const from = paneIndexOf(state, name);
  if (from === index) return focusPane(state, index);
  // Dragging a pane's workspace onto the other pane swaps them, so neither
  // drop loses what was already there.
  let panes = state.panes;
  if (from >= 0) panes = replacePane(panes, from, { ...panes[from], workspace: panes[index].workspace });
  panes = replacePane(panes, index, { ...panes[index], workspace: name });
  return collapseEmpty({ ...state, panes, focused: index });
}

/**
 * Open `name` in a pane of its own. With both panes already open there is no
 * room for a third, so it lands in the other pane instead; an empty lone pane
 * simply takes it, since splitting would leave nothing behind.
 */
export function splitWorkspace(
  state: WorkspacePanesState,
  name: string,
  direction: SplitDirection,
): WorkspacePanesState {
  const at = paneIndexOf(state, name);
  if (state.panes.length >= MAX_PANES) {
    if (at >= 0) return focusPane(state, at);
    const to = state.focused === 0 ? 1 : 0;
    return openWorkspaceIn(state, name, to);
  }
  if (state.panes[state.focused].workspace == null || at === state.focused) {
    return { ...openWorkspace(state, name), direction };
  }
  return {
    panes: [...state.panes, { id: nextId(state), workspace: name }],
    focused: state.panes.length,
    direction,
  };
}

export function focusPane(state: WorkspacePanesState, index: number): WorkspacePanesState {
  if (index === state.focused || !state.panes[index]) return state;
  return { ...state, focused: index };
}

/**
 * Close pane `index`. The last pane is never removed — the view always has one
 * pane — so closing it just empties it, which puts the app back on the
 * dashboard.
 */
export function closePane(state: WorkspacePanesState, index: number): WorkspacePanesState {
  if (!state.panes[index]) return state;
  if (state.panes.length < 2) {
    return { ...state, panes: replacePane(state.panes, index, { ...state.panes[index], workspace: null }) };
  }
  const panes = state.panes.filter((_, i) => i !== index);
  const focused = state.focused === index ? 0 : state.focused > index ? state.focused - 1 : state.focused;
  return { ...state, panes, focused: Math.min(focused, panes.length - 1) };
}

/** Close the pane showing `name`, if any (the sidebar's "Close" and archiving). */
export function closeWorkspace(state: WorkspacePanesState, name: string): WorkspacePanesState {
  const at = paneIndexOf(state, name);
  return at < 0 ? state : closePane(state, at);
}

/** Follow a server-side rename so the open pane does not go blank. */
export function renameWorkspace(
  state: WorkspacePanesState,
  from: string,
  to: string,
): WorkspacePanesState {
  const at = paneIndexOf(state, from);
  if (at < 0 || from === to) return state;
  return { ...state, panes: replacePane(state.panes, at, { ...state.panes[at], workspace: to }) };
}

/** Drop workspaces that were archived, deleted, or belong to another daemon. */
export function retainWorkspaces(
  state: WorkspacePanesState,
  keep: (name: string) => boolean,
): WorkspacePanesState {
  let next = state;
  for (const pane of state.panes) {
    if (pane.workspace != null && !keep(pane.workspace)) next = closeWorkspace(next, pane.workspace);
  }
  return next;
}

function collapseEmpty(state: WorkspacePanesState): WorkspacePanesState {
  if (state.panes.length < 2) return state;
  const empty = state.panes.findIndex((pane) => pane.workspace == null);
  return empty < 0 ? state : closePane(state, empty);
}
