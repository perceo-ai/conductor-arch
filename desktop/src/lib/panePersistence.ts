import {
  MAX_PANES,
  emptyPanes,
  type SplitDirection,
  type WorkspacePanesState,
} from "./workspacePanes";

// Workspace panes survive an app restart. Saved to localStorage like the other
// renderer-local view state (prefs.ts): which workspaces are on screen is a
// per-machine view of the daemon, not workspace state, so it does not belong in
// the daemon's database — two people on one daemon keep their own layout.
//
// Panes are stored per "realm" — one entry per daemon the app can point at —
// because workspace names and chat-thread ids only mean anything on the daemon
// that issued them. Switching daemons swaps realms; each keeps its own panes.
//
// A restore never trusts the stored names: the caller supplies `keep`, checked
// against the live inventory, so a workspace deleted while the app was closed
// does not come back as a dead pane.

const KEY = "archductor.workspacePanes.v2";
/** The tab-strip era's entries (groups of tabs per pane), read once for migration. */
const LEGACY_KEY = "archductor.workspaceTabs.v1";

export interface PersistedPanes {
  panes: { workspace: string | null }[];
  focused: number;
  direction: SplitDirection;
  /** Chat thread each open workspace was last on. */
  threads: Record<string, number>;
}

/** The shape written by the tab strip, before a pane held exactly one workspace. */
interface LegacyPersistedTabs {
  groups?: { tabs?: unknown; active?: unknown }[];
  focused?: number;
  direction?: unknown;
  threads?: Record<string, number>;
}

export function serializePanes(
  state: WorkspacePanesState,
  threads: Record<string, number>,
): PersistedPanes {
  const open = new Set(state.panes.map((pane) => pane.workspace).filter((name) => name != null));
  return {
    panes: state.panes.map((pane) => ({ workspace: pane.workspace })),
    focused: state.focused,
    direction: state.direction,
    // Only open workspaces: thread memory for a closed one died with its pane.
    threads: Object.fromEntries(Object.entries(threads).filter(([name]) => open.has(name))),
  };
}

/**
 * Rebuild live pane state from a stored entry, keeping only workspaces that
 * still exist (`keep`). Handles a stale or hand-edited entry the same way as a
 * legitimate one: drop what is unknown, collapse what is empty, clamp the rest.
 */
export function materializePanes(
  data: PersistedPanes | null,
  keep: (name: string) => boolean,
): { state: WorkspacePanesState; threads: Record<string, number> } {
  if (!data) return { state: emptyPanes(), threads: {} };
  const seen = new Set<string>();
  const panes = (Array.isArray(data.panes) ? data.panes : [])
    .map((pane) => pane?.workspace)
    .filter((name): name is string => {
      if (typeof name !== "string" || seen.has(name) || !keep(name)) return false;
      seen.add(name);
      return true;
    })
    .slice(0, MAX_PANES)
    .map((workspace, id) => ({ id, workspace }));
  if (panes.length === 0) return { state: emptyPanes(), threads: {} };
  const focused = Math.min(Math.max(0, Math.floor(data.focused ?? 0)), panes.length - 1);
  const direction: SplitDirection = data.direction === "down" ? "down" : "right";
  const threads = Object.fromEntries(
    Object.entries(data.threads ?? {}).filter(
      ([name, thread]) => seen.has(name) && typeof thread === "number",
    ),
  );
  return { state: { panes, focused, direction }, threads };
}

function readAll(): Record<string, PersistedPanes> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, PersistedPanes>) : {};
  } catch {
    return {};
  }
}

function readLegacy(): Record<string, LegacyPersistedTabs> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LEGACY_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, LegacyPersistedTabs>) : {};
  } catch {
    return {};
  }
}

/**
 * Carry a tab-strip entry over: each pane keeps the tab it had active, and the
 * rest are dropped — there is nowhere invisible left to hold them.
 */
export function migrateLegacyPanes(legacy: LegacyPersistedTabs): PersistedPanes {
  const panes = (Array.isArray(legacy.groups) ? legacy.groups : []).map((group) => {
    const tabs = (Array.isArray(group?.tabs) ? group.tabs : []).filter(
      (tab): tab is string => typeof tab === "string",
    );
    const active = typeof group?.active === "string" && tabs.includes(group.active) ? group.active : tabs[0];
    return { workspace: active ?? null };
  });
  return {
    panes,
    focused: typeof legacy.focused === "number" ? legacy.focused : 0,
    direction: legacy.direction === "down" ? "down" : "right",
    threads: legacy.threads ?? {},
  };
}

export function loadPaneRealm(realm: string): PersistedPanes | null {
  const current = readAll()[realm];
  if (current) return current;
  const legacy = readLegacy()[realm];
  return legacy ? migrateLegacyPanes(legacy) : null;
}

export function savePaneRealm(realm: string, data: PersistedPanes): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [realm]: data }));
  } catch {
    // Storage full or unavailable: panes simply will not survive this restart.
  }
}
