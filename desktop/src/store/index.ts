import { connectEvents, onWindowFocus, pathExists } from "@/bridge/client";
import { applyEvent } from "./reducer";
import { nav } from "./nav";
import { workspacesStore } from "./workspaces";
import { repositoriesStore } from "./repositories";
import { toastsStore } from "./toasts";
import { actions } from "./actions";

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
export type { DialogSpec } from "./dialogs";
export { setupStore } from "./setup";
export { threadsStore } from "./threads";
export { terminalStore } from "./terminal";
export { interactionsStore } from "./interactions";
export { toastsStore } from "./toasts";
export type { Toast } from "./toasts";
export { updateMetrics, metricsEnabled } from "./metrics";

let focusWired = false;
let startPromise: Promise<void> | null = null;

/**
 * Drop any registered project whose root directory no longer exists on disk,
 * surfacing a toast for each. A missing root makes every operation on that repo
 * fail (workspace creation, config), so pruning keeps the sidebar honest.
 */
async function pruneMissingRepositories(): Promise<void> {
  const rows = repositoriesStore.state.order
    .map((n) => repositoriesStore.row(n))
    .filter((r): r is NonNullable<typeof r> => !!r);
  for (const r of rows) {
    const res = await pathExists(r.rootPath).catch(() => ({ exists: true }));
    if (res.exists) continue;
    toastsStore.error(`Project “${r.name}” is missing on disk (${r.rootPath}) — removed.`);
    await actions.removeRepository(r.name).catch(() => {});
  }
}

/** Load the workspace/repository inventory from archcar. */
export async function refreshInventory(): Promise<void> {
  await Promise.all([workspacesStore.refresh(), repositoriesStore.refresh()]);
  await pruneMissingRepositories().catch(() => {});
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
