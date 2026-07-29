import { For, Show } from "solid-js";
import { nav, workspacesStore } from "@/store";

// Left sidebar: nav group (Dashboard/History) + projects header + workspace list.
// Each workspace row reads only its own store slice, so a status change on one
// workspace re-renders that row alone.

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

export default function Sidebar(props: { collapsed: boolean; onToggle: () => void }) {
  return (
    <aside class="sidebar" classList={{ collapsed: props.collapsed }}>
      <div class="sidebar-chrome drag-region">
        <button class="ui-button-icon" onClick={props.onToggle} title="Hide sidebar">
          ⇤
        </button>
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
        <button class="ui-button-icon" title="Add repository (coming soon)" disabled>
          +
        </button>
      </div>

      <div class="workspace-list">
        <Show
          when={workspacesStore.state.order.length > 0}
          fallback={<div class="empty-state">No workspaces yet</div>}
        >
          <For each={workspacesStore.state.order}>{(name) => <WorkspaceRow name={name} />}</For>
        </Show>
      </div>
    </aside>
  );
}
