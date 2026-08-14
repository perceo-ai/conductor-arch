import { createResource, createSignal, For, Show } from "solid-js";
import { nav, workspacesStore, repositoriesStore, dialogs, actions, toastsStore } from "@/store";
import { repoAvatar, openExternal } from "@/bridge/client";
import { openContextMenu, type ContextMenuItem } from "./ContextMenu";
import ResizeHandle from "./ResizeHandle";
import { createPersistedWidth } from "@/lib/persistedWidth";
import { workspaceStatusKind, STATUS_COLOR, STATUS_LABEL } from "@/lib/workspaceStatus";

// Run a lifecycle action and surface any failure as a toast rather than
// swallowing it — a silently-failing remove/delete is how a dead workspace ends
// up un-removable.
function runAction(label: string, p: Promise<unknown>): void {
  void p.catch((err) => toastsStore.error(`${label} failed: ${(err as Error).message}`));
}

// Right-click actions for a workspace row — GTK parity (Rename / Duplicate /
// Archive|Restore / Delete) plus Open and a "More…" escape hatch to the full
// actions dialog (branch ops, link dir, default provider). Uses in-app dialogs
// rather than window.prompt/confirm, which are unreliable in the Electron
// renderer (that's why "Remove" appeared to do nothing).
function workspaceMenuItems(name: string): ContextMenuItem[] {
  const archived = () => workspacesStore.row(name)?.status === "archived";
  return [
    { label: "Open", run: () => nav.selectWorkspace(name) },
    {
      label: "Rename…",
      run: () =>
        dialogs.open({
          kind: "confirm",
          title: `Rename ${name}`,
          message: "Give the workspace a new name.",
          confirmLabel: "Rename",
          input: { label: "New name", initialValue: name },
          onConfirm: (v) => {
            if (v && v !== name) runAction("Rename", actions.renameWorkspace(name, v));
          },
        }),
    },
    {
      label: "Duplicate…",
      run: () =>
        dialogs.open({
          kind: "confirm",
          title: `Duplicate ${name}`,
          message: "Create a copy of this workspace under a new name.",
          confirmLabel: "Duplicate",
          input: { label: "New name", initialValue: `${name}-copy` },
          onConfirm: (v) => {
            if (v) runAction("Duplicate", actions.duplicateWorkspace(name, v));
          },
        }),
    },
    archived()
      ? { label: "Restore", run: () => runAction("Restore", actions.restoreWorkspace(name)) }
      : {
          label: "Archive",
          run: () =>
            dialogs.open({
              kind: "confirm",
              title: `Archive ${name}`,
              message: `Archive "${name}"? It moves out of the active board but keeps its worktree.`,
              confirmLabel: "Archive",
              onConfirm: () => runAction("Archive", actions.archiveWorkspace(name)),
            }),
        },
    {
      label: "Delete",
      destructive: true,
      run: () =>
        dialogs.open({
          kind: "confirm",
          title: `Delete ${name}`,
          message: `Delete "${name}"? Removes the worktree and deletes the local branch (can discard unmerged commits).`,
          confirmLabel: "Delete",
          destructive: true,
          onConfirm: () => runAction("Delete", actions.deleteWorkspace(name, true, true)),
        }),
    },
    { label: "More actions…", run: () => dialogs.open({ kind: "workspace-actions", workspace: name }) },
  ];
}

// Right-click actions for a project (repository) row.
function repoMenuItems(repo: string): ContextMenuItem[] {
  return [
    {
      label: "New workspace",
      run: () => dialogs.open({ kind: "create-workspace", repository: repo }),
    },
    {
      label: "Open in editor",
      run: () => {
        const root = repositoriesStore.row(repo)?.rootPath;
        if (root) runAction("Open", openExternal(root));
      },
    },
    {
      label: "Remove project",
      destructive: true,
      run: () =>
        dialogs.open({
          kind: "confirm",
          title: `Remove ${repo}`,
          message: `Remove project "${repo}"? Drops it (and its workspace records) from Archductor. Local files are left alone.`,
          confirmLabel: "Remove project",
          destructive: true,
          onConfirm: () => runAction("Remove project", actions.removeRepository(repo)),
        }),
    },
  ];
}

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 520;

// Left sidebar: nav group (Dashboard/History) + projects list. Repositories are
// the top-level rows; each repo's workspaces are nested beneath it so a repo
// with no workspaces yet still appears. Each workspace row reads only its own
// store slice, so a status change on one workspace re-renders that row alone.

function WorkspaceRow(props: { name: string }) {
  const row = () => workspacesStore.row(props.name);
  const selected = () => nav.selectedWorkspace() === props.name;
  const statusKind = () => workspaceStatusKind(row() ?? {});
  return (
    <button
      class="workspace-row-shell"
      classList={{ selected: selected() }}
      onClick={() => nav.selectWorkspace(props.name)}
      onContextMenu={(e) => openContextMenu(e, workspaceMenuItems(props.name))}
    >
      <span class="workspace-row-head">
        <span
          class="workspace-status-dot"
          style={{ "background-color": STATUS_COLOR[statusKind()] }}
          title={STATUS_LABEL[statusKind()]}
        />
        <span class="row-name">{props.name}</span>
      </span>
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
      {/* Left-rail indicators from the UX strategy: active agents, blocked
          work, and PR state, so branches can be triaged without opening them. */}
      <Show when={row()}>
        {(r) => (
          <span class="row-indicators">
            <Show when={r().activeSessions > 0}>
              <span class="row-chip row-chip-agent" title={`${r().activeSessions} active agent session(s)`}>
                ▶ {r().activeSessions}
              </span>
            </Show>
            <Show when={r().blockedTasks > 0}>
              <span class="row-chip row-chip-blocked" title={`${r().blockedTasks} blocked task(s)`}>
                ! {r().blockedTasks}
              </span>
            </Show>
            <Show when={r().blockedTasks === 0 && r().openTasks > 0}>
              <span class="row-chip row-chip-task" title={`${r().openTasks} open task(s)`}>
                ☰ {r().openTasks}
              </span>
            </Show>
            <Show when={r().prNumber != null}>
              <span class="row-chip row-chip-pr" title={`Pull request #${r().prNumber} ${r().prState ?? ""}`}>
                PR #{r().prNumber}
              </span>
            </Show>
          </span>
        )}
      </Show>
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
      <div class="project-row" onContextMenu={(e) => openContextMenu(e, repoMenuItems(props.repo))}>
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
  const [width, setWidth] = createPersistedWidth("sidebar.width", 320, SIDEBAR_MIN, SIDEBAR_MAX);
  return (
    <aside
      class="sidebar"
      classList={{ collapsed: props.collapsed }}
      style={props.collapsed ? undefined : { width: `${width()}px`, "min-width": `${width()}px` }}
    >
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
          classList={{ active: nav.activePage() === "projects" }}
          onClick={() => nav.goToPage("projects")}
        >
          <span class="sidebar-nav-icon">▢</span>
          <span class="sidebar-nav-label">Projects</span>
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

      <div class="sidebar-footer">
        <button
          class="sidebar-nav-button"
          classList={{ active: nav.activePage() === "settings" }}
          onClick={() => nav.goToPage("settings")}
        >
          <span class="sidebar-nav-icon">⚙</span>
          <span class="sidebar-nav-label">Settings</span>
        </button>
      </div>

      <Show when={!props.collapsed}>
        <ResizeHandle edge="right" width={width} min={SIDEBAR_MIN} max={SIDEBAR_MAX} onChange={setWidth} />
      </Show>
    </aside>
  );
}
