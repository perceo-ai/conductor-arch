import { createSignal } from "solid-js";

// Invalidation signal for the workspace-intelligence resources in the Summary
// tab (summary, tasks, current-chat context). archcar broadcasts
// `summary_updated` / `task_updated` when it rewrites context; bumping this
// version makes the visible resources refetch without polling.
const [version, setVersion] = createSignal(0);

export const intelStore = {
  version,
  /** Mark a workspace's context stale. Global on purpose: the panel refetches
   * only while mounted, and per-workspace bookkeeping buys nothing at this
   * scale. */
  refreshWorkspaceIntel(_workspace: string): void {
    setVersion((v) => v + 1);
  },
};
