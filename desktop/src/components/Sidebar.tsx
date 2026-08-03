import { createResource, createSignal, For, Show } from "solid-js";
import { nav, workspacesStore, repositoriesStore, dialogs } from "@/store";
import { repoAvatar } from "@/bridge/client";

// Left sidebar: nav group (Dashboard/History) + projects list. Repositories are
// the top-level rows; each repo's workspaces are nested beneath it so a repo
// with no workspaces yet still appears. Each workspace row reads only its own
// store slice, so a status change on one workspace re-renders that row alone.

function WorkspaceRow(props: { name: string }) {
  const row = () => workspacesStore.row(props.name);
  const selected = () => nav.selectedWorkspace() === props.name;
  return (
    <button
      class="workspace-row-shell"
      classList={{ selected: selected() }}
      onClick={() => nav.selectWorkspace(props.name)}
    >
      <span class="row-name">{props.name}</span>
      <span class="row-meta">
        <Show when={row()} fallback="…">
          {(r) => (
            <>
              {r().status} · {r().branch}
              <Show when={r().additions || r().deletions}>
                {" "}
                · +{r().additions} −{r().deletions}
              </Show>
            </>
          )}
        </Show>
      </span>
    </button>
  );
}

// Same owner avatar as the add-project picker, resolved from the repo's git
// remote. Falls back to a monogram glyph while loading or for non-GitHub repos.
function ProjectAvatar(props: { repo: string }) {
  const row = () => repositoriesStore.row(props.repo);
  const [broken, setBroken] = createSignal(false);
  const [avatar] = createResource(
    () => row(),
    async (r) => {
      const res = await repoAvatar({ rootPath: r.rootPath, remoteName: r.remoteName });
      return res.ok ? res.avatarUrl : "";
    },
  );
  return (
    <Show
      when={avatar() && !broken()}
      fallback={<span class="project-avatar project-avatar-fallback">{props.repo[0]?.toUpperCase() ?? "?"}</span>}
    >
      <img class="project-avatar" src={avatar()} alt="" loading="lazy" onError={() => setBroken(true)} />
    </Show>
  );
}

function ProjectGroup(props: { repo: string }) {
  const names = () =>
    workspacesStore.state.order.filter(
      (name) => workspacesStore.row(name)?.repository === props.repo,
    );
  return (
    <div class="project-group">
      <div class="project-row">
        <ProjectAvatar repo={props.repo} />
        <span class="project-name">{props.repo}</span>
        <button
          class="ui-button-icon project-add"
          title="New workspace"
          onClick={() => dialogs.open({ kind: "create-workspace", repository: props.repo })}
        >
          +
        </button>
      </div>
      <For each={names()}>{(name) => <WorkspaceRow name={name} />}</For>
    </div>
  );
}

export default function Sidebar(props: { collapsed: boolean; onToggle: () => void }) {
  return (
    <aside class="sidebar" classList={{ collapsed: props.collapsed }}>
      <div class="sidebar-chrome drag-region">
        {/* Left third of this row is left clear for the window controls (see
            .window-controls, top-left). Back/forward + the sidebar toggle sit on
            the right, with the toggle to the right of the arrows. */}
        <div class="spacer" />
        <button
          class="ui-button-icon"
          disabled={!nav.canBack()}
          onClick={() => nav.back()}
          title="Back"
        >
          ‹
        </button>
        <button
          class="ui-button-icon"
          disabled={!nav.canForward()}
          onClick={() => nav.forward()}
          title="Forward"
        >
          ›
        </button>
        <button class="ui-button-icon" onClick={props.onToggle} title="Hide sidebar">
          ⇤
        </button>
      </div>

      <div class="sidebar-nav-group">
        <button
          class="sidebar-nav-button"
          classList={{ active: nav.activePage() === "dashboard" }}
          onClick={() => nav.goToPage("dashboard")}
        >
          <span class="sidebar-nav-icon">▦</span>
          <span class="sidebar-nav-label">Dashboard</span>
        </button>
        <button
          class="sidebar-nav-button"
          classList={{ active: nav.activePage() === "history" }}
          onClick={() => nav.goToPage("history")}
        >
          <span class="sidebar-nav-icon">◷</span>
          <span class="sidebar-nav-label">History</span>
        </button>
      </div>

      <div class="projects-header">
        <span class="title">Projects</span>
        <button
          class="ui-button-icon"
          title="Add project"
          onClick={() => dialogs.open({ kind: "add-project" })}
        >
          +
        </button>
      </div>

      <div class="workspace-list">
        <Show
          when={repositoriesStore.state.order.length > 0}
          fallback={<div class="empty-state">No projects yet</div>}
        >
          <For each={repositoriesStore.state.order}>{(repo) => <ProjectGroup repo={repo} />}</For>
        </Show>
      </div>
    </aside>
  );
}
