// Workspace tabs — the browser-style strip above the workspace view.
//
// Every open workspace is a tab in exactly one group. There is one group until
// a tab is split off, and never more than two: a third pane would leave each
// workspace too narrow to read, and two keeps the focus model obvious. A group
// whose last tab closes or moves away collapses, so an empty pane never shows.
//
// Pure functions over plain data: the nav store owns the signal, and these are
// what it calls, so the rules are testable without a renderer.

export type SplitDirection = "right" | "down";

export interface TabGroup {
  /** Stable for the group's lifetime, so a pane is not remounted when its neighbour collapses. */
  id: number;
  tabs: string[];
  active: string | null;
}

export interface WorkspaceTabsState {
  groups: TabGroup[];
  /** Index into `groups` of the group that keyboard shortcuts and the sidebar act on. */
  focused: number;
  direction: SplitDirection;
}

export const MAX_TAB_GROUPS = 2;

export function emptyTabs(): WorkspaceTabsState {
  return { groups: [{ id: 0, tabs: [], active: null }], focused: 0, direction: "right" };
}

/** The workspace shown in the focused group, which is the app's selected workspace. */
export function activeWorkspace(state: WorkspaceTabsState): string | null {
  return state.groups[state.focused]?.active ?? null;
}

export function groupIndexOf(state: WorkspaceTabsState, name: string): number {
  return state.groups.findIndex((group) => group.tabs.includes(name));
}

/** Open `name` as a tab, or focus it where it already is. */
export function openTab(state: WorkspaceTabsState, name: string): WorkspaceTabsState {
  const existing = groupIndexOf(state, name);
  if (existing >= 0) {
    const group = state.groups[existing];
    if (existing === state.focused && group.active === name) return state;
    return {
      ...state,
      focused: existing,
      groups: replaceGroup(state.groups, existing, { ...group, active: name }),
    };
  }
  const group = state.groups[state.focused];
  const at = group.active ? group.tabs.indexOf(group.active) + 1 : group.tabs.length;
  const tabs = [...group.tabs.slice(0, at), name, ...group.tabs.slice(at)];
  return {
    ...state,
    groups: replaceGroup(state.groups, state.focused, { ...group, tabs, active: name }),
  };
}

export function closeTab(state: WorkspaceTabsState, name: string): WorkspaceTabsState {
  const index = groupIndexOf(state, name);
  if (index < 0) return state;
  return collapseEmpty({
    ...state,
    groups: replaceGroup(state.groups, index, withoutTab(state.groups[index], name)),
  });
}

export function focusGroup(state: WorkspaceTabsState, index: number): WorkspaceTabsState {
  if (index === state.focused || !state.groups[index]) return state;
  return { ...state, focused: index };
}

/**
 * Split `name` into its own pane. With a split already open there is no room
 * for a third, so the tab moves to the other pane instead. A group's only tab
 * cannot be split off: that would leave the group it came from empty.
 */
export function splitTab(
  state: WorkspaceTabsState,
  name: string,
  direction: SplitDirection,
): WorkspaceTabsState {
  const from = groupIndexOf(state, name);
  if (from < 0) return state;
  if (state.groups.length >= MAX_TAB_GROUPS) {
    const to = from === 0 ? 1 : 0;
    return moveTab(state, name, to, state.groups[to].tabs.length);
  }
  if (state.groups[from].tabs.length < 2) return state;
  const id = Math.max(...state.groups.map((group) => group.id)) + 1;
  const groups = replaceGroup(state.groups, from, withoutTab(state.groups[from], name));
  return {
    groups: [...groups, { id, tabs: [name], active: name }],
    focused: groups.length,
    direction,
  };
}

/** Move `name` to position `index` of group `to`, focusing it there. */
export function moveTab(
  state: WorkspaceTabsState,
  name: string,
  to: number,
  index: number,
): WorkspaceTabsState {
  const from = groupIndexOf(state, name);
  if (from < 0 || !state.groups[to]) return state;
  let groups = state.groups;
  if (from !== to) groups = replaceGroup(groups, from, withoutTab(groups[from], name));
  const target = groups[to];
  const rest = target.tabs.filter((tab) => tab !== name);
  const at = Math.max(0, Math.min(index, rest.length));
  groups = replaceGroup(groups, to, {
    ...target,
    tabs: [...rest.slice(0, at), name, ...rest.slice(at)],
    active: name,
  });
  return collapseEmpty({ ...state, groups, focused: to });
}

/** Follow a server-side rename so the open tab does not go blank. */
export function renameTab(state: WorkspaceTabsState, from: string, to: string): WorkspaceTabsState {
  const index = groupIndexOf(state, from);
  if (index < 0 || from === to) return state;
  const group = state.groups[index];
  return {
    ...state,
    groups: replaceGroup(state.groups, index, {
      ...group,
      tabs: group.tabs.map((tab) => (tab === from ? to : tab)),
      active: group.active === from ? to : group.active,
    }),
  };
}

/** Drop tabs whose workspace was archived, deleted, or belongs to another daemon. */
export function retainTabs(
  state: WorkspaceTabsState,
  keep: (name: string) => boolean,
): WorkspaceTabsState {
  let next = state;
  for (const group of state.groups) {
    for (const tab of group.tabs) {
      if (!keep(tab)) next = closeTab(next, tab);
    }
  }
  return next;
}

function withoutTab(group: TabGroup, name: string): TabGroup {
  const at = group.tabs.indexOf(name);
  if (at < 0) return group;
  const tabs = group.tabs.filter((tab) => tab !== name);
  const active = group.active === name ? (tabs[at] ?? tabs[at - 1] ?? null) : group.active;
  return { ...group, tabs, active };
}

function collapseEmpty(state: WorkspaceTabsState): WorkspaceTabsState {
  if (state.groups.length < 2) return state;
  const empty = state.groups.findIndex((group) => group.tabs.length === 0);
  if (empty < 0) return state;
  const groups = state.groups.filter((_, i) => i !== empty);
  const focused = state.focused === empty ? 0 : state.focused > empty ? state.focused - 1 : state.focused;
  return { ...state, groups, focused: Math.min(focused, groups.length - 1) };
}

function replaceGroup(groups: TabGroup[], index: number, group: TabGroup): TabGroup[] {
  return groups.map((existing, i) => (i === index ? group : existing));
}
