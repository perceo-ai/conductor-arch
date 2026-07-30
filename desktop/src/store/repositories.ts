import { createStore, reconcile } from "solid-js/store";
import { recordUpdate } from "./metrics";
import { send } from "@/bridge/client";
import { logState } from "@/lib/log";
import type { ArchcarRepositorySummary } from "@/bridge/protocol";

// Keyed repository store for the sidebar projects list.

export interface RepositoryRow {
  id: number;
  name: string;
  rootPath: string;
  defaultBranch: string;
  remoteName: string;
  activeWorkspaces: number;
  totalWorkspaces: number;
}

interface RepositoriesState {
  byName: Record<string, RepositoryRow>;
  order: string[];
}

const [state, setState] = createStore<RepositoriesState>({ byName: {}, order: [] });

function rowFromSummary(s: ArchcarRepositorySummary): RepositoryRow {
  return {
    id: s.id,
    name: s.name,
    rootPath: s.root_path,
    defaultBranch: s.default_branch,
    remoteName: s.remote_name,
    activeWorkspaces: s.active_workspaces,
    totalWorkspaces: s.total_workspaces,
  };
}

export const repositoriesStore = {
  state,

  setAll(rows: RepositoryRow[]) {
    const byName: Record<string, RepositoryRow> = {};
    for (const r of rows) byName[r.name] = r;
    setState("byName", reconcile(byName));
    setState("order", reconcile(rows.map((r) => r.name)));
    recordUpdate("repositories.setAll");
    logState("repositories.setAll", { count: rows.length });
  },

  row(name: string): RepositoryRow | undefined {
    return state.byName[name];
  },

  async refresh(): Promise<void> {
    const res = await send({ type: "list_repositories" });
    if (res.type !== "repositories") return;
    this.setAll(res.repositories.map(rowFromSummary));
  },
};
