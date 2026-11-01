import { connectEvents, onWindowFocus, send } from "@/bridge/client";
import { applyEvent } from "./reducer";
import { nav } from "./nav";
import { workspacesStore } from "./workspaces";
import { repositoriesStore } from "./repositories";
import { threadsStore } from "./threads";
import { layoutPresetsStore } from "./layoutPresets";
import { clientsStore, restoreTabsForActiveDaemon, tabRealmKey } from "./clients";
import { appearanceStore } from "./appearance";

export { nav } from "./nav";
export { chatStore } from "./chat";
export type { ChatSlice, ChatUiPhase } from "./chat";
export { loadThread } from "./reducer";
export { workspacesStore } from "./workspaces";
export type { WorkspaceRow } from "./workspaces";
export { repositoriesStore } from "./repositories";
export type { RepositoryRow } from "./repositories";
export { actions, MissingLocalRepositoryError, LiveSourceSessionError } from "./actions";
export { dialogs } from "./dialogs";
export type { DialogSpec, ConfirmSpec } from "./dialogs";
export { setupStore } from "./setup";
export { clientsStore } from "./clients";
export { threadsStore } from "./threads";
export { terminalStore } from "./terminal";
export { interactionsStore } from "./interactions";
export { newChatContextStore } from "./newChatContext";
export { toastsStore } from "./toasts";
export { updateStore } from "./update";
export type { Toast } from "./toasts";
export { prefsStore } from "./prefs";
export type { Prefs } from "./prefs";
export { appearanceStore } from "./appearance";
export type { Appearance } from "./appearance";
export { layoutStore } from "./layout";
export { layoutPresetsStore } from "./layoutPresets";
export { updateMetrics, metricsEnabled } from "./metrics";
export { uiStore } from "./ui";
export { restoreTabsForActiveDaemon } from "./clients";

let focusWired = false;
let startPromise: Promise<void> | null = null;

/**
 * Load the workspace/repository inventory from archcar.
 *
 * A project whose root is missing on disk is intentionally left visible (not
 * hidden) so it can be removed via the sidebar's right-click "Remove project"
 * action — hiding it stranded a dead workspace with no way to delete it.
 */
export async function refreshInventory(): Promise<void> {
  if (await refreshInventorySnapshot()) return;
  await Promise.all([workspacesStore.refresh(), repositoriesStore.refresh()]);
  await refreshWorkspaceChats();
}

async function refreshInventorySnapshot(): Promise<boolean> {
  try {
    const res = await send({ type: "get_inventory_snapshot" });
    if (res.type !== "inventory_snapshot") return false;
    repositoriesStore.setSummaries(res.repositories);
    workspacesStore.setSummaries(res.workspaces);
    threadsStore.setMany(res.chat_threads);
    return true;
  } catch {
    return false;
  }
}

export async function refreshWorkspaceChats(): Promise<void> {
  const activeWorkspaces = workspacesStore.state.order.filter(
    (name) => workspacesStore.row(name)?.status !== "archived",
  );
  await threadsStore.refreshMany(activeWorkspaces);
}

/**
 * Wire the archcar event stream into the reducer. Idempotent: concurrent or
 * repeat calls share one in-flight init. If init fails (e.g. the daemon isn't
 * up yet) the memo is cleared so a later call can retry.
 */
export function startStore(): Promise<void> {
  if (startPromise) return startPromise;
  const attempt = (async () => {
    if (!focusWired) {
      onWindowFocus((focused) => {
        nav.setWindowFocused(focused);
        // Re-pull inventory when the window regains focus (parity with the GTK
        // sidebar's on-focus refresh). Failures are non-fatal.
        if (focused) void refreshInventory().catch(() => {});
      });
      focusWired = true;
    }
    await connectEvents((event) => applyEvent(event));
    const appearanceReady = appearanceStore.refresh().catch(() => appearanceStore.apply());
    // The tab realm is the active daemon's, so its identity must be known
    // before the restore — quietly, since the switcher will refresh again.
    await clientsStore.ensureLoaded();
    let inventoryOk = true;
    await refreshInventory().catch(() => {
      inventoryOk = false;
    });
    // Bring back the tabs from last run — unless the user already opened
    // something while we were loading, which wins. A failed inventory pull
    // leaves the restore owed instead: restoring against an empty store would
    // drop every saved tab and persist the loss. WorkspacePanes retries once
    // a good inventory lands (the on-focus refresh, typically).
    if (nav.workspaceTabs().groups.every((group) => group.tabs.length === 0)) {
      if (inventoryOk && workspacesStore.loaded()) restoreTabsForActiveDaemon();
      else nav.deferTabRestore();
    } else {
      // A workspace was already opened while this was loading (it wins over the
      // saved tabs) — still point future persistence at the right daemon's
      // realm, independent of whether the restore itself ran.
      nav.setTabRealm(tabRealmKey());
    }
    await appearanceReady;
    const selected = nav.selectedWorkspace();
    const repository = selected ? workspacesStore.row(selected)?.repository : undefined;
    await layoutPresetsStore.load(repository).catch(() => {});
  })();
  startPromise = attempt.catch((err) => {
    startPromise = null;
    throw err;
  });
  return startPromise;
}
