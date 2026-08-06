import { For, Show, createMemo, createSignal } from "solid-js";
import { nav, workspacesStore, repositoriesStore, dialogs } from "@/store";
import type { WorkspaceRow } from "@/store";
import { titleCaseWorkspace } from "@/lib/text";
import { workspaceStatusKind, STATUS_COLOR } from "@/lib/workspaceStatus";

// Kanban dashboard — port of crates/gtk-app/src/dashboard.rs. Workspaces bucket
// into Ready/Running/Review/Archived columns, filterable by project tab.
//
// Rerender control: each derived slice is a createMemo over the keyed workspace
// store. Row objects keep stable identity across reconciles, so <For> reuses the
// same card DOM when only a sibling changes — a status flip on one workspace
// re-renders that card alone (mirrors refresh.rs WorkspaceStatusChanged scoping).

type Bucket = "ready" | "running" | "review" | "archived";

function bucketOf(r: WorkspaceRow): Bucket {
  if (r.status === "archived") return "archived";
  if (r.prNumber != null && (r.prState ?? "").toLowerCase() === "open") return "review";
  if (r.runRunning || r.activeSessions > 0) return "running";
  return "ready";
}

const COLUMNS: { bucket: Bucket; title: string; empty: string }[] = [
  { bucket: "ready", title: "Ready", empty: "No ready workspaces" },
  { bucket: "running", title: "Running", empty: "Nothing running" },
  { bucket: "review", title: "Review", empty: "Nothing in review" },
  { bucket: "archived", title: "Archived", empty: "No archived workspaces" },
];

function ProjectTab(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      class="ws-tab-shell"
      classList={{ "ws-tab-active": props.active }}
      onClick={props.onClick}
    >
      <span class="ws-tab-label">{props.label}</span>
    </button>
  );
}

function DashboardCard(props: { row: WorkspaceRow }) {
  const diffHot = () => props.row.changedFiles > 0;
  const activity = () => {
    const r = props.row;
    if (r.runRunning) return "Running";
    if (r.activeSessions > 0) return "Agent active";
    if (r.status === "archived") return "Archived";
    return "Ready";
  };
  const meta = () =>
    props.row.prNumber != null
      ? `${props.row.repository} · PR #${props.row.prNumber}`
      : props.row.repository;
  return (
    <button
      class="flat workspace-card-action"
      title={`Open workspace ${props.row.name}`}
      onClick={() => nav.selectWorkspace(props.row.name)}
    >
      <div
        class="workspace-card shell-card"
        style={{ "border-left-color": STATUS_COLOR[workspaceStatusKind(props.row)] }}
      >
        <div class="dashboard-card-top">
          <span class="card-branch">{props.row.branch}</span>
          <span class={diffHot() ? "card-diff-hot" : "card-diff"}>
            {diffHot() ? `+${props.row.changedFiles}` : "clean"}
          </span>
        </div>
        <div class="card-title">{titleCaseWorkspace(props.row.name)}</div>
        <div class="card-meta">{meta()}</div>
        <div class="dashboard-card-footer">
          <span class="card-activity">{activity()}</span>
          <Show when={props.row.openTodos > 0}>
            <span class="card-meta">
              {props.row.openTodos} {props.row.openTodos === 1 ? "todo" : "todos"}
            </span>
          </Show>
        </div>
      </div>
    </button>
  );
}

function KanbanColumn(props: { title: string; empty: string; cards: WorkspaceRow[] }) {
  return (
    <div class="kanban-column">
      <div class="kanban-column-header">
        <span class="column-title">{props.title}</span>
        <span class="column-count">{props.cards.length}</span>
      </div>
      <Show
        when={props.cards.length > 0}
        fallback={<div class="column-empty">{props.empty}</div>}
      >
        <For each={props.cards}>{(row) => <DashboardCard row={row} />}</For>
      </Show>
    </div>
  );
}

export function DashboardPage() {
  const [project, setProject] = createSignal<string | null>(null);

  const projectNames = createMemo(() => repositoriesStore.state.order);

  const visibleRows = createMemo(() => {
    const sel = project();
    return workspacesStore.state.order
      .map((name) => workspacesStore.row(name))
      .filter((r): r is WorkspaceRow => !!r)
      .filter((r) => sel == null || r.repository === sel);
  });

  const byBucket = createMemo(() => {
    const groups: Record<Bucket, WorkspaceRow[]> = {
      ready: [],
      running: [],
      review: [],
      archived: [],
    };
    for (const r of visibleRows()) groups[bucketOf(r)].push(r);
    return groups;
  });

  return (
    <div class="dashboard page-shell">
      <div class="dashboard-header page-header">
        <div class="dashboard-title">Dashboard</div>
        <div class="dashboard-subtitle">
          See what is ready, running, under review, or archived across your projects.
        </div>
        <div class="project-tabs">
          <ProjectTab
            label="All projects"
            active={project() == null}
            onClick={() => setProject(null)}
          />
          <For each={projectNames()}>
            {(name) => (
              <ProjectTab
                label={name}
                active={project() === name}
                onClick={() => setProject(name)}
              />
            )}
          </For>
        </div>
      </div>
      <Show
        when={projectNames().length > 0}
        fallback={
          <div class="dashboard-onboarding">
            <div class="onboarding-card">
              <div class="onboarding-title">No projects yet</div>
              <div class="onboarding-copy">
                Add a local repository or clone one to create your first workspace and
                start running agents.
              </div>
              <button
                class="suggested-action onboarding-cta"
                onClick={() => dialogs.open({ kind: "add-project" })}
              >
                Add your first project
              </button>
            </div>
          </div>
        }
      >
        <div class="kanban-board page-board">
          <For each={COLUMNS}>
            {(col) => (
              <KanbanColumn title={col.title} empty={col.empty} cards={byBucket()[col.bucket]} />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
