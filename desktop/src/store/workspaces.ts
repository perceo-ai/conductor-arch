import { createStore, reconcile } from "solid-js/store";
import { recordUpdate } from "./metrics";
import { send } from "@/bridge/client";
import { logState } from "@/lib/log";
import type { ArchcarWorkspaceSummary } from "@/bridge/protocol";

// Keyed workspace store. Row components read `workspaces.byName[name].status` so a
// status change reconciles exactly one row (equivalent to
// refresh.rs WorkspaceStatusChanged / WorkspaceNavRow scoping).

export interface WorkspaceRow {
  id: number;
  name: string;
  path: string;
  branch: string;
  baseRef: string;
  status: string; // "active" | "archived" | ...
  repository: string;
  additions: number;
  deletions: number;
  openTodos: number;
  openTasks: number;
  blockedTasks: number;
  activeSessions: number;
  runRunning: boolean;
  changedFiles: number;
  prNumber?: number;
  prState?: string;
  prUrl?: string;
  updatedAt: string;
}

interface WorkspacesState {
  byName: Record<string, WorkspaceRow>;
  order: string[]; // display order
}

const [state, setState] = createStore<WorkspacesState>({ byName: {}, order: [] });

function rowFromSummary(s: ArchcarWorkspaceSummary): WorkspaceRow {
  return {
    id: s.id,
    name: s.name,
    path: s.path,
    branch: s.branch,
    baseRef: s.base_ref,
    status: s.status,
    repository: s.repository_name,
    additions: s.diff_additions,
    deletions: s.diff_deletions,
    openTodos: s.open_todos,
    openTasks: s.open_tasks ?? 0,
    blockedTasks: s.blocked_tasks ?? 0,
    activeSessions: s.active_sessions,
    runRunning: s.run_running,
    changedFiles: s.changed_files,
    prNumber: s.pull_request_number,
    prState: s.pull_request_state,
    prUrl: s.pull_request_url,
    updatedAt: s.updated_at,
  };
}

export const workspacesStore = {
  state,

  /** Full inventory replace — reconcile keeps unchanged rows stable. */
  setAll(rows: WorkspaceRow[]) {
    const byName: Record<string, WorkspaceRow> = {};
    for (const r of rows) byName[r.name] = r;
    setState("byName", reconcile(byName));
    setState("order", reconcile(rows.map((r) => r.name)));
    recordUpdate("workspaces.setAll");
    logState("workspaces.setAll", { count: rows.length });
  },

  /** Patch a single field on one row — touches only that row. */
  patch(name: string, patch: Partial<WorkspaceRow>) {
    if (!state.byName[name]) return;
    setState("byName", name, patch);
    recordUpdate(`workspaces.patch.${name}`);
    logState("workspaces.patch", { name, patch });
  },

  row(name: string): WorkspaceRow | undefined {
    return state.byName[name];
  },

  /** Pull the full workspace inventory from archcar and reconcile. */
  async refresh(): Promise<void> {
    const res = await send({ type: "list_workspaces" });
    if (res.type !== "workspaces") return;
    this.setAll(res.workspaces.map(rowFromSummary));
  },
};
