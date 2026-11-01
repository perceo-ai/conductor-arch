import {
  MAX_TAB_GROUPS,
  emptyTabs,
  type SplitDirection,
  type WorkspaceTabsState,
} from "./workspaceTabs";

// Workspace tabs survive an app restart. Saved to localStorage like the other
// renderer-local view state (prefs.ts): which tabs are open is a per-machine
// view of the daemon, not workspace state, so it does not belong in the
// daemon's database — two people on one daemon keep their own tab sets.
//
// Tabs are stored per "realm" — one entry per daemon the app can point at —
// because workspace names and chat-thread ids only mean anything on the daemon
// that issued them. Switching daemons swaps realms; each keeps its own tabs.
//
// A restore never trusts the stored names: the caller supplies `keep`, checked
// against the live inventory, so a workspace deleted while the app was closed
// does not come back as a dead tab.

const KEY = "archductor.workspaceTabs.v1";

export interface PersistedTabs {
  groups: { tabs: string[]; active: string | null }[];
  focused: number;
  direction: SplitDirection;
  /** Chat thread each open workspace was last on. */
  threads: Record<string, number>;
}

export function serializeTabs(
  state: WorkspaceTabsState,
  threads: Record<string, number>,
): PersistedTabs {
  const open = new Set(state.groups.flatMap((group) => group.tabs));
  return {
    groups: state.groups.map((group) => ({ tabs: [...group.tabs], active: group.active })),
    focused: state.focused,
    direction: state.direction,
    // Only open tabs: thread memory for a closed workspace died with its tab.
    threads: Object.fromEntries(Object.entries(threads).filter(([name]) => open.has(name))),
  };
}

/**
 * Rebuild live tab state from a stored entry, keeping only workspaces that
 * still exist (`keep`). Handles a stale or hand-edited entry the same way as a
 * legitimate one: drop what is unknown, collapse what is empty, clamp the rest.
 */
export function materializeTabs(
  data: PersistedTabs | null,
  keep: (name: string) => boolean,
): { state: WorkspaceTabsState; threads: Record<string, number> } {
  if (!data) return { state: emptyTabs(), threads: {} };
  const seen = new Set<string>();
  const groups = data.groups
    .map((group) => {
      const tabs = group.tabs.filter((name) => {
        if (typeof name !== "string" || seen.has(name) || !keep(name)) return false;
        seen.add(name);
        return true;
      });
      const active = group.active != null && tabs.includes(group.active) ? group.active : (tabs.at(-1) ?? null);
      return { tabs, active };
    })
    .filter((group) => group.tabs.length > 0)
    .slice(0, MAX_TAB_GROUPS)
    .map((group, id) => ({ ...group, id }));
  if (groups.length === 0) return { state: emptyTabs(), threads: {} };
  const focused = Math.min(Math.max(0, Math.floor(data.focused ?? 0)), groups.length - 1);
  const direction: SplitDirection = data.direction === "down" ? "down" : "right";
  const threads = Object.fromEntries(
    Object.entries(data.threads ?? {}).filter(
      ([name, thread]) => seen.has(name) && typeof thread === "number",
    ),
  );
  return { state: { groups, focused, direction }, threads };
}

function readAll(): Record<string, PersistedTabs> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, PersistedTabs>) : {};
  } catch {
    return {};
  }
}

export function loadTabRealm(realm: string): PersistedTabs | null {
  return readAll()[realm] ?? null;
}

export function saveTabRealm(realm: string, data: PersistedTabs): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [realm]: data }));
  } catch {
    // Storage full or unavailable: tabs simply will not survive this restart.
  }
}
