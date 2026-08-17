import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { nav, workspacesStore, repositoriesStore, dialogs } from "@/store";
import type { WorkspaceRow } from "@/store";
import { send } from "@/bridge/client";
import type { BackgroundTask } from "@/bridge/protocol";
import { titleCaseWorkspace } from "@/lib/text";
import { dashboardTriageBadges, workspaceStatusKind, STATUS_COLOR } from "@/lib/workspaceStatus";
import {
  backgroundTaskIsActive,
  backgroundTaskSummary,
  backgroundTaskTone,
} from "@/lib/backgroundTasks";

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

// Background development tasks: agents working without a human at the keyboard.
// Polled, since archcar emits no background-task event yet.
function BackgroundTaskStrip(props: { repository: string | null }) {
  const [tasks, { refetch }] = createResource(async (): Promise<BackgroundTask[]> => {
    try {
      const res = await send({ type: "list_background_tasks", active_only: false });
      return res.type === "background_tasks" ? res.tasks : [];
    } catch {
      return [];
    }
  });
  const timer = setInterval(() => void refetch(), 5000);
  onCleanup(() => clearInterval(timer));

  const visible = createMemo(() => {
    const rows = (tasks() ?? []).filter(
      (task) => props.repository == null || task.repository_name === props.repository,
    );
    // Everything in flight, plus the most recent finished ones for triage.
    const active = rows.filter((task) => backgroundTaskIsActive(task.status));
    const finished = rows.filter((task) => !backgroundTaskIsActive(task.status)).slice(-3);
    return [...active, ...finished];
  });

  async function cancel(task: BackgroundTask) {
    try {
      await send({ type: "cancel_background_task", background_task_id: task.id });
    } finally {
      await refetch();
    }
  }

  return (
    <Show when={visible().length > 0 || props.repository != null}>
      <div class="background-task-strip">
        <div class="background-task-head">
          <span class="section-title">Background tasks</span>
          <Show when={props.repository}>
            {(repository) => (
              <button
                class="secondary-action"
                onClick={() => dialogs.open({ kind: "background-task", repository: repository() })}
              >
                New background task
              </button>
            )}
          </Show>
        </div>
        <For each={visible()}>
          {(task) => (
            <div
              class="background-task-row"
              classList={{ [`background-task-tone-${backgroundTaskTone(task.status)}`]: true }}
            >
              <div class="background-task-main">
                <span class="background-task-title">{task.title}</span>
                <span class="background-task-detail" title={backgroundTaskSummary(task)}>
                  {backgroundTaskSummary(task)}
                </span>
              </div>
              <Show when={task.workspace_name}>
                {(workspace) => (
                  <button class="secondary-action" onClick={() => nav.selectWorkspace(workspace())}>
                    Open
                  </button>
                )}
              </Show>
              <Show when={backgroundTaskIsActive(task.status)}>
                <button class="ui-button-destructive" onClick={() => void cancel(task)}>
                  Cancel
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

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
  const hasDiffStats = () => props.row.additions > 0 || props.row.deletions > 0;
  const badges = () => dashboardTriageBadges(props.row);
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
        <div class="card-title">{titleCaseWorkspace(props.row.name)}</div>
        <div class="card-meta dashboard-card-essentials">
          <Show when={hasDiffStats()} fallback={<span>{props.row.status}</span>}>
            <span class="workspace-row-diff">
              <span class="workspace-row-additions">+{props.row.additions}</span>
              <span class="workspace-row-deletions">-{props.row.deletions}</span>
            </span>
          </Show>
          <Show when={props.row.prNumber != null}>
            <span>PR #{props.row.prNumber}</span>
          </Show>
        </div>
        <Show when={badges().length > 0}>
          <div class="dashboard-card-badges" aria-label="Workspace triage summary">
            <For each={badges()}>
              {(badge) => (
                <span class={`triage-badge triage-badge-${badge.tone}`} title={badge.title}>
                  {badge.label}
                </span>
              )}
            </For>
          </div>
        </Show>
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
  const selectedProject = createMemo(() => project());

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
        <div class="dashboard-heading-row">
          <div>
            <div class="dashboard-title">Dashboard</div>
            <div class="dashboard-subtitle">
              See what is ready, running, under review, or archived across your projects.
            </div>
          </div>
          <Show when={selectedProject()}>
            {(repository) => (
              <button
                class="suggested-action dashboard-new-workspace"
                title={`New workspace in ${repository()}`}
                onClick={() => dialogs.open({ kind: "create-workspace", repository: repository() })}
              >
                New workspace
              </button>
            )}
          </Show>
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
        <BackgroundTaskStrip repository={project()} />
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
