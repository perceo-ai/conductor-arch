import { createResource, createSignal, For, Show } from "solid-js";
import { nav, workspacesStore, repositoriesStore, dialogs, actions, toastsStore } from "@/store";
import { repoAvatar, openExternal } from "@/bridge/client";
import { openContextMenu, openContextMenuFromKeyboard, type ContextMenuItem } from "./ContextMenu";
import ResizeHandle from "./ResizeHandle";
import { createPersistedWidth } from "@/lib/persistedWidth";
import { SIDEBAR_MAX, SIDEBAR_MIN, measuredWidth, panelDragMax } from "@/lib/panelWidths";
import Icon, { type IconName } from "./Icon";
import {
  dashboardTriageBadges,
  type DashboardTriageBadgeTone,
} from "@/lib/workspaceStatus";
import { deriveWorkspacePrAction, workspacePrActionInput, type WorkspacePrActionKind } from "@/lib/workspacePrAction";
import { titleCaseWorkspace } from "@/lib/text";
import { runShellAction } from "@/lib/shellAction";
import ClientSwitcher from "./ClientSwitcher";

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
        if (root) runShellAction("Open in editor", openExternal(root));
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


const ROW_TRIAGE_ICON: Partial<Record<DashboardTriageBadgeTone, "brain" | "play" | "git-compare">> = {
  agent: "brain",
  run: "play",
  pr: "git-compare",
};

const ROW_TRIAGE_TONES = new Set<DashboardTriageBadgeTone>(["agent", "run", "pr"]);

const WORKSPACE_GIT_STATE_ICON: Record<WorkspacePrActionKind, IconName> = {
  create: "git-pull-request",
  push: "arrow-up",
  merge: "git-merge",
  view: "external",
  none: "circle-check",
};

// Left sidebar: nav group (Dashboard/History) + workspace list. Repositories are
// the top-level rows; each repo's workspaces are nested beneath it so a repo
// with no workspaces yet still appears. Each workspace row reads only its own
// store slice, so a status change on one workspace re-renders that row alone.

function WorkspaceRow(props: { name: string }) {
  const row = () => workspacesStore.row(props.name);
  const selected = () => nav.selectedWorkspace() === props.name;
  const gitState = () => deriveWorkspacePrAction(workspacePrActionInput(row(), undefined));
  const hasDiffStats = () => ((row()?.additions ?? 0) > 0 || (row()?.deletions ?? 0) > 0);
  const compactBadges = () =>
    dashboardTriageBadges(row() ?? {})
      .filter((badge) => ROW_TRIAGE_TONES.has(badge.tone))
      .slice(0, 2);
  return (
    <button
      class="workspace-row-shell"
      classList={{ selected: selected() }}
      onClick={() => nav.selectWorkspace(props.name)}
      onContextMenu={(e) => openContextMenu(e, workspaceMenuItems(props.name))}
      onKeyDown={(e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          openContextMenuFromKeyboard(e, workspaceMenuItems(props.name));
        }
      }}
    >
      <span class="workspace-row-head">
        <span
          class={`workspace-git-state workspace-git-state-${gitState().action}`}
          title={gitState().title}
        >
          <Icon name={WORKSPACE_GIT_STATE_ICON[gitState().action]} />
        </span>
        <span class="row-name" title={props.name}>{titleCaseWorkspace(props.name)}</span>
        <Show when={compactBadges().length > 0}>
          <span class="workspace-row-indicators">
            <For each={compactBadges()}>
              {(badge) => {
                const icon = ROW_TRIAGE_ICON[badge.tone] ?? "git-compare";
                return (
                  <span class={`workspace-row-indicator workspace-row-indicator-${badge.tone}`} title={badge.title}>
                    <Icon name={icon} />
                  </span>
                );
              }}
            </For>
          </span>
        </Show>
        <Show when={hasDiffStats()}>
          <span class="workspace-row-diff">
            <span class="workspace-row-additions">+{row()?.additions ?? 0}</span>
            <span class="workspace-row-deletions">-{row()?.deletions ?? 0}</span>
          </span>
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
      <div
        class="project-row"
        tabIndex={0}
        onContextMenu={(e) => openContextMenu(e, repoMenuItems(props.repo))}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            openContextMenuFromKeyboard(e, repoMenuItems(props.repo));
          }
        }}
      >
        <ProjectAvatar repo={props.repo} />
        <span class="project-name">{props.repo}</span>
        <button
          class="ui-button-icon project-add"
          title="New workspace"
          onClick={() => dialogs.open({ kind: "create-workspace", repository: props.repo })}
        >
          <Icon name="plus" />
        </button>
      </div>
      <For each={names()}>{(name) => <WorkspaceRow name={name} />}</For>
    </div>
  );
}

export default function Sidebar(props: { collapsed: boolean; onToggle: () => void }) {
  const [width, setWidth] = createPersistedWidth("sidebar.width", 280, SIDEBAR_MIN, SIDEBAR_MAX);
  return (
    <aside
      class="sidebar"
      data-focus-target="sidebar-search"
      tabIndex={-1}
      classList={{ collapsed: props.collapsed }}
      // flex-basis, not min-width: the column keeps its dragged width but can
      // still give ground (down to the CSS min) when the window gets narrow.
      style={props.collapsed ? undefined : { width: `${width()}px`, "flex-basis": `${width()}px` }}
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
          <Icon name="arrow-left" />
        </button>
        <button
          class="ui-button-icon"
          disabled={!nav.canForward()}
          onClick={() => nav.forward()}
          title="Forward"
        >
          <Icon name="arrow-right" />
        </button>
        <button class="ui-button-icon" onClick={props.onToggle} title="Hide sidebar">
          <Icon name="panel-left" />
        </button>
      </div>

      <ClientSwitcher />

      <div class="sidebar-nav-group">
        <button
          class="sidebar-nav-button"
          classList={{ active: nav.activePage() === "dashboard" }}
          onClick={() => nav.goToPage("dashboard")}
        >
          <Icon name="layout-dashboard" class="sidebar-nav-icon" />
          <span class="sidebar-nav-label">Dashboard</span>
        </button>
        <button
          class="sidebar-nav-button"
          classList={{ active: nav.activePage() === "history" }}
          onClick={() => nav.goToPage("history")}
        >
          <Icon name="history" class="sidebar-nav-icon" />
          <span class="sidebar-nav-label">History</span>
        </button>
      </div>

      <div class="projects-header">
        <span class="title">Workspaces</span>
        <button
            class="ui-button-icon"
            title="Add repository"
            onClick={() => dialogs.open({ kind: "add-project" })}
          >
            <Icon name="plus" />
          </button>
      </div>

      <div class="workspace-list">
        <Show
          when={repositoriesStore.state.order.length > 0}
          fallback={<div class="empty-state">No repositories yet</div>}
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
          <Icon name="settings" class="sidebar-nav-icon" />
          <span class="sidebar-nav-label">Settings</span>
        </button>
      </div>

      <Show when={!props.collapsed}>
        <ResizeHandle
          edge="right"
          width={width}
          min={SIDEBAR_MIN}
          max={() =>
            panelDragMax({
              viewportWidth: window.innerWidth,
              otherPanelWidth: measuredWidth(".ws-right-panel"),
              hardMax: SIDEBAR_MAX,
              panelMin: SIDEBAR_MIN,
            })
          }
          onChange={setWidth}
        />
      </Show>
    </aside>
  );
}
