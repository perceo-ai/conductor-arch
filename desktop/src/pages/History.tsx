import { For, Show, createMemo, createSignal } from "solid-js";
import { nav, workspacesStore } from "@/store";
import type { WorkspaceRow } from "@/store";
import { titleCaseWorkspace } from "@/lib/text";
import { workspaceStatusKind, STATUS_COLOR, STATUS_LABEL } from "@/lib/workspaceStatus";

// History page — port of history.rs workspace list. All workspaces sorted by
// lifecycle state then recency, filterable All/Active/Archived. Reuses the
// keyed workspace store (no new RPC); clicking a row opens its command center.

type Filter = "all" | "active" | "archived";

function stateOf(r: WorkspaceRow): "Running" | "Review" | "Ready" | "Archived" {
  if (r.status === "archived") return "Archived";
  if (r.prNumber != null && (r.prState ?? "").toLowerCase() === "open") return "Review";
  if (r.runRunning || r.activeSessions > 0) return "Running";
  return "Ready";
}

const STATE_ORDER: Record<string, number> = { Running: 0, Review: 1, Ready: 2, Archived: 3 };

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
];

export function HistoryPage() {
  const [filter, setFilter] = createSignal<Filter>("all");

  const rows = createMemo(() => {
    const f = filter();
    return workspacesStore.state.order
      .map((n) => workspacesStore.row(n))
      .filter((r): r is WorkspaceRow => !!r)
      .filter((r) => {
        if (f === "active") return r.status !== "archived";
        if (f === "archived") return r.status === "archived";
        return true;
      })
      .slice()
      .sort((a, b) => {
        const sa = STATE_ORDER[stateOf(a)];
        const sb = STATE_ORDER[stateOf(b)];
        if (sa !== sb) return sa - sb;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  });

  return (
    <div class="page-shell history-view">
      <div class="page-header dashboard-header">
        <div class="dashboard-title">History</div>
        <div class="dashboard-subtitle">Workspaces across your projects, most active first.</div>
        <div class="project-tabs">
          <For each={FILTERS}>
            {(f) => (
              <button
                class="ws-tab-shell"
                classList={{ "ws-tab-active": filter() === f.key }}
                onClick={() => setFilter(f.key)}
              >
                <span class="ws-tab-label">{f.label}</span>
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="page-body">
        <Show
          when={rows().length > 0}
          fallback={<div class="empty-state">No workspaces</div>}
        >
          <For each={rows()}>
            {(r) => (
              <button class="history-row" onClick={() => nav.selectWorkspace(r.name)}>
                <span class="history-row-head">
                  <span
                    class="workspace-status-dot"
                    style={{ "background-color": STATUS_COLOR[workspaceStatusKind(r)] }}
                    title={STATUS_LABEL[workspaceStatusKind(r)]}
                  />
                  <span class="workspace-name">{titleCaseWorkspace(r.name)}</span>
                </span>
                <span class="workspace-meta">
                  {r.repository} · {r.branch} · {stateOf(r)}
                </span>
                <span class="card-meta">
                  <Show when={r.additions || r.deletions}>
                    +{r.additions} −{r.deletions}
                    <Show when={r.openTodos > 0}> · </Show>
                  </Show>
                  <Show when={r.openTodos > 0}>
                    {r.openTodos} {r.openTodos === 1 ? "todo" : "todos"}
                  </Show>
                </span>
              </button>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
