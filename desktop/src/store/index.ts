import { connectEvents, onWindowFocus } from "@/bridge/client";
import { applyEvent } from "./reducer";
import { nav } from "./nav";
import { workspacesStore } from "./workspaces";
import { repositoriesStore } from "./repositories";

export { nav } from "./nav";
export { chatStore } from "./chat";
export type { ChatSlice, ChatUiPhase } from "./chat";
export { loadThread } from "./reducer";
export { workspacesStore } from "./workspaces";
export type { WorkspaceRow } from "./workspaces";
export { repositoriesStore } from "./repositories";
export type { RepositoryRow } from "./repositories";
export { threadsStore } from "./threads";
export { terminalStore } from "./terminal";
export { updateMetrics, metricsEnabled } from "./metrics";

let focusWired = false;
let startPromise: Promise<void> | null = null;

/** Load the workspace/repository inventory from archcar. */
export async function refreshInventory(): Promise<void> {
  await Promise.all([workspacesStore.refresh(), repositoriesStore.refresh()]);
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
