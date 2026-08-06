import { For, Show, createMemo } from "solid-js";
import { nav, repositoriesStore, workspacesStore, dialogs } from "@/store";
import type { RepositoryRow, WorkspaceRow } from "@/store";
import { titleCaseWorkspace } from "@/lib/text";

// Projects page — repositories with their workspaces grouped underneath. Reuses
// the keyed repository + workspace stores (no new RPC). Clicking a workspace
// opens its command center.

function ProjectGroup(props: { repo: RepositoryRow }) {
  const workspaces = createMemo(() =>
    workspacesStore.state.order
      .map((n) => workspacesStore.row(n))
      .filter((r): r is WorkspaceRow => !!r && r.repository === props.repo.name),
  );
  return (
    <div class="repo-group">
      <div class="repo-section-header">
        <span class="title">{props.repo.name}</span>
        <span class="card-meta">
          {props.repo.activeWorkspaces}/{props.repo.totalWorkspaces} active · {props.repo.defaultBranch}
        </span>
        <button
          class="ui-button-sm"
          title="New workspace"
          onClick={() => dialogs.open({ kind: "create-workspace", repository: props.repo.name })}
        >
          + Workspace
        </button>
      </div>
      <Show
        when={workspaces().length > 0}
        fallback={<div class="empty-state">No workspaces</div>}
      >
        <For each={workspaces()}>
          {(w) => (
            <div class="project-workspace-row">
              <button class="history-row" onClick={() => nav.selectWorkspace(w.name)}>
                <span class="workspace-name">{titleCaseWorkspace(w.name)}</span>
                <span class="workspace-meta">
                  {w.branch} · {w.status}
                </span>
              </button>
              <button
                class="ui-button-icon"
                title="Workspace actions"
                onClick={() => dialogs.open({ kind: "workspace-actions", workspace: w.name })}
              >
                ⋯
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

export function ProjectsPage() {
  const repos = createMemo(() =>
    repositoriesStore.state.order
      .map((n) => repositoriesStore.row(n))
      .filter((r): r is RepositoryRow => !!r),
  );
  return (
    <div class="page-shell">
      <div class="page-header dashboard-header">
        <div class="projects-header-row">
          <div>
            <div class="dashboard-title">Projects</div>
            <div class="dashboard-subtitle">Repositories and their workspaces.</div>
          </div>
          <button
            class="suggested-action"
            onClick={() => dialogs.open({ kind: "add-project" })}
          >
            + Add project
          </button>
        </div>
      </div>
      <div class="page-body">
        <Show
          when={repos().length > 0}
          fallback={
            <div class="dashboard-onboarding">
              <div class="onboarding-card">
                <div class="onboarding-title">No projects yet</div>
                <div class="onboarding-copy">
                  Add a local repository or clone one to start creating workspaces.
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
          <For each={repos()}>{(repo) => <ProjectGroup repo={repo} />}</For>
        </Show>
      </div>
    </div>
  );
}
