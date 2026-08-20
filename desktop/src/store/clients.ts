import { createStore } from "solid-js/store";

import { clients as bridge, type ClientSummary, type ClientsResult } from "@/bridge/client";
import { logAction, logState } from "@/lib/log";
import { actions } from "./actions";
import { setupStore } from "./setup";
import { toastsStore } from "./toasts";

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
  await actions.refreshInventory().catch(() => undefined);
  await setupStore.check().catch(() => undefined);
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

  /** Label for the active client — what the switcher shows when closed. */
  activeLabel(): string {
    if (state.envAddress) return state.envAddress;
    const active = state.clients.find((c) => c.id === state.activeId);
    return active?.label ?? "This machine";
  },

  /** The connection is pinned by the environment and cannot be switched here. */
  pinned(): boolean {
    return !!state.envAddress;
  },

  refresh: () => run("clients refreshed", () => bridge.list()),

  /** Switch to a saved client, or to this machine with null. */
  async activate(id: string | null): Promise<boolean> {
    if (id === state.activeId) return true;
    logAction("switch client", { id });
    return run("client switched", () => bridge.activate(id), resync);
  },

  /** Save a daemon and switch to it. Main verifies before committing. */
  async add(opts: { label?: string; address: string; token: string }): Promise<boolean> {
    logAction("add client", { address: opts.address });
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
