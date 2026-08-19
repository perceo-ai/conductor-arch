import { connectEvents, onWindowFocus } from "@/bridge/client";
import { applyEvent } from "./reducer";
import { nav } from "./nav";
import { workspacesStore } from "./workspaces";
import { repositoriesStore } from "./repositories";
import { threadsStore } from "./threads";

export { nav } from "./nav";
export { chatStore } from "./chat";
export type { ChatSlice, ChatUiPhase } from "./chat";
export { loadThread } from "./reducer";
export { workspacesStore } from "./workspaces";
export type { WorkspaceRow } from "./workspaces";
export { repositoriesStore } from "./repositories";
export type { RepositoryRow } from "./repositories";
export { actions } from "./actions";
export { dialogs } from "./dialogs";
export type { DialogSpec, ConfirmSpec } from "./dialogs";
export { setupStore } from "./setup";
export { threadsStore } from "./threads";
export { terminalStore } from "./terminal";
export { interactionsStore } from "./interactions";
export { newChatContextStore } from "./newChatContext";
export { toastsStore } from "./toasts";
export type { Toast } from "./toasts";
export { prefsStore } from "./prefs";
export type { Prefs } from "./prefs";
export { updateMetrics, metricsEnabled } from "./metrics";
export { uiStore } from "./ui";

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
  await Promise.all([workspacesStore.refresh(), repositoriesStore.refresh()]);
  await refreshWorkspaceChats();
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
    await refreshInventory().catch(() => {});
  })();
  startPromise = attempt.catch((err) => {
    startPromise = null;
    throw err;
  });
  return startPromise;
}
