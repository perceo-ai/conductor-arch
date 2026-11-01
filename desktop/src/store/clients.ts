import { createStore } from "solid-js/store";

import {
  clients as bridge,
  type ClientSummary,
  type ClientsResult,
  type SelectedDaemon,
} from "@/bridge/client";
import { logAction, logState } from "@/lib/log";
import { actions } from "./actions";
import { bumpDaemonEpoch } from "./daemonEpoch";
import { providersStore } from "./providers";
import { setupStore } from "./setup";
import { toastsStore } from "./toasts";
import { layoutPresetsStore } from "./layoutPresets";
import { nav } from "./nav";
import { workspacesStore } from "./workspaces";

// The saved daemons this machine can point at. One of them is active, or none
// for this machine's local daemon. Main owns the files (clients.json plus the
// remote.json mirror the CLI reads); this store is the renderer's view of them.
//
// Switching is not just a file write: the workspace inventory belongs to the
// daemon we just left, and the setup gate's rows describe its host. Both are
// re-pulled here so a switch lands on a consistent screen.

interface ClientsState {
  activeId: string | null;
  clients: ClientSummary[];
  /** Set when ARCHDUCTOR_ARCHCAR_REMOTE pins the connection; switching is off. */
  envAddress: string | null;
  busy: boolean;
  loaded: boolean;
}

const [state, setState] = createStore<ClientsState>({
  activeId: null,
  clients: [],
  envAddress: null,
  busy: false,
  loaded: false,
});

const lastWorkspaceByClient = new Map<string, string>();

function clientKey(id: string | null): string {
  return id ?? "local";
}

/** Storage realm for the active daemon's workspace tabs (see tabPersistence). */
function tabRealmKey(): string {
  if (state.envAddress) return `env:${state.envAddress}`;
  return state.activeId != null ? `client:${state.activeId}` : "local";
}

/** A stored tab name is only kept when this daemon still has the workspace. */
function liveWorkspace(name: string): boolean {
  const row = workspacesStore.row(name);
  return row != null && row.status !== "archived";
}

/** Bring back the active daemon's saved tabs, validated against the inventory. */
export function restoreTabsForActiveDaemon(): void {
  nav.restoreWorkspaceTabs(tabRealmKey(), liveWorkspace);
}

function rememberCurrentWorkspace(id: string | null): void {
  const selected = nav.selectedWorkspace();
  if (selected) lastWorkspaceByClient.set(clientKey(id), selected);
}

function restoreWorkspaceForClient(id: string | null): void {
  // The old daemon's tabs are already saved under its own realm; what comes
  // back is whatever this daemon's realm holds, checked against the inventory
  // resync just pulled. Thread ids in it are this daemon's too.
  restoreTabsForActiveDaemon();
  if (nav.selectedWorkspace() != null) return;
  // No saved tabs for this daemon: fall back to the workspace that was on
  // screen the last time this session pointed at it, then the dashboard.
  const remembered = lastWorkspaceByClient.get(clientKey(id));
  if (remembered && workspacesStore.row(remembered)) {
    nav.selectWorkspace(remembered);
  } else {
    nav.goToDashboard();
  }
}

function applyResult(res: ClientsResult): boolean {
  if (!res.ok) {
    toastsStore.error(res.error);
    return false;
  }
  setState({
    activeId: res.activeId,
    clients: res.clients,
    envAddress: res.envAddress ?? null,
    loaded: true,
  });
  return true;
}

/** Re-pull everything that belonged to the previous daemon. */
async function resync(): Promise<void> {
  // Invalidate anything still in flight to the daemon we just left, before the
  // re-pull below issues requests to the new one. Without this a slow response
  // from the old daemon can land afterwards and overwrite the new state.
  bumpDaemonEpoch();
  await actions.refreshInventory().catch(() => undefined);
  await setupStore.check().catch(() => undefined);
  // The new daemon may know a different set of agents than the old one, so a
  // stale registry would offer providers this host cannot actually run.
  await providersStore.load().catch(() => undefined);
  restoreWorkspaceForClient(state.activeId);
  const selected = nav.selectedWorkspace();
  const repository = selected ? workspacesStore.row(selected)?.repository : undefined;
  await layoutPresetsStore.load(repository).catch(() => undefined);
}

async function run(
  label: string,
  call: () => Promise<ClientsResult>,
  after?: () => Promise<void>,
): Promise<boolean> {
  setState("busy", true);
  try {
    const res = await call();
    const ok = applyResult(res);
    if (ok && after) await after();
    logState(label, { ok, activeId: state.activeId });
    return ok;
  } catch (err) {
    toastsStore.error(`${label} failed: ${(err as Error).message}`);
    return false;
  } finally {
    setState("busy", false);
  }
}

export const clientsStore = {
  state,

  /**
   * Which daemon the app is pointed at. The single place that precedence is
   * decided — environment pin, then saved client, then this machine — so
   * anything that needs to *address* that daemon cannot disagree with what the
   * sidebar is showing. `activeLabel` and `isRemote` below both derive from it.
   */
  selectedDaemon(): SelectedDaemon {
    if (state.envAddress) return { kind: "env" };
    if (state.activeId != null) return { kind: "client", clientId: state.activeId };
    return { kind: "local" };
  },

  /** Label for the active client — what the switcher shows when closed. */
  activeLabel(): string {
    const daemon = this.selectedDaemon();
    if (daemon.kind === "env") return state.envAddress ?? "Environment";
    if (daemon.kind === "local") return "This machine";
    return state.clients.find((c) => c.id === daemon.clientId)?.label ?? "This machine";
  },

  /**
   * Requests are going to another machine's daemon. Gates the actions that only
   * make sense across a machine boundary, like importing a workspace here.
   */
  isRemote(): boolean {
    return this.selectedDaemon().kind !== "local";
  },

  /** The connection is pinned by the environment and cannot be switched here. */
  pinned(): boolean {
    return !!state.envAddress;
  },

  refresh: () => run("clients refreshed", () => bridge.list()),

  /**
   * Quiet one-shot load for boot: startStore needs the active daemon's id to
   * pick the right tab realm before restoring, and must not toast when a build
   * without client support says no.
   */
  async ensureLoaded(): Promise<void> {
    if (state.loaded) return;
    try {
      applyResult(await bridge.list());
    } catch {
      // Leave defaults: this machine.
    }
  },

  /** Switch to a saved client, or to this machine with null. */
  async activate(id: string | null): Promise<boolean> {
    if (id === state.activeId) return true;
    logAction("switch client", { id });
    rememberCurrentWorkspace(state.activeId);
    return run("client switched", () => bridge.activate(id), resync);
  },

  /** Save a daemon and switch to it. Main verifies before committing. */
  async add(opts: { label?: string; address: string; token: string }): Promise<boolean> {
    logAction("add client", { address: opts.address });
    rememberCurrentWorkspace(state.activeId);
    return run("client added", () => bridge.add(opts), resync);
  },

  async remove(id: string): Promise<boolean> {
    const wasActive = state.activeId === id;
    logAction("remove client", { id });
    return run("client removed", () => bridge.remove(id), wasActive ? resync : undefined);
  },

  async rename(id: string, label: string): Promise<boolean> {
    logAction("rename client", { id });
    return run("client renamed", () => bridge.rename({ id, label }));
  },
};
