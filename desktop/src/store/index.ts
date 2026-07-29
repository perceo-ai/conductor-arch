import { connectEvents, onWindowFocus } from "@/bridge/client";
import { applyEvent } from "./reducer";
import { nav } from "./nav";
import { workspacesStore } from "./workspaces";
import { repositoriesStore } from "./repositories";

export { nav } from "./nav";
export { chatStore } from "./chat";
export type { ChatSlice, ChatUiPhase } from "./chat";
export { workspacesStore } from "./workspaces";
export type { WorkspaceRow } from "./workspaces";
export { repositoriesStore } from "./repositories";
export type { RepositoryRow } from "./repositories";
export { updateMetrics, metricsEnabled } from "./metrics";

let started = false;

/** Load the workspace/repository inventory from archcar. */
export async function refreshInventory(): Promise<void> {
  await Promise.all([workspacesStore.refresh(), repositoriesStore.refresh()]);
}

/** Wire the archcar event stream into the reducer. Call once at app start. */
export async function startStore(): Promise<void> {
  if (started) return;
  started = true;
  onWindowFocus((focused) => {
    nav.setWindowFocused(focused);
    // Re-pull inventory when the window regains focus (parity with the GTK
    // sidebar's on-focus refresh). Failures are non-fatal.
    if (focused) void refreshInventory().catch(() => {});
  });
  await connectEvents((event) => applyEvent(event));
  await refreshInventory().catch(() => {});
}
