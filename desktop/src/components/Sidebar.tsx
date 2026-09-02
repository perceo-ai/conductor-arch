import { createResource, createSignal, For, Show } from "solid-js";
import { nav, workspacesStore, repositoriesStore, dialogs, actions, toastsStore, prefsStore } from "@/store";
import { repoAvatar, openExternal } from "@/bridge/client";
import { openContextMenu, openContextMenuFromKeyboard, type ContextMenuItem } from "./ContextMenu";
import ResizeHandle from "./ResizeHandle";
import { createPersistedWidth } from "@/lib/persistedWidth";
import { SIDEBAR_MAX, SIDEBAR_MIN, panelDragMax } from "@/lib/panelWidths";
import Icon from "./Icon";
import { workspaceRowActivity } from "@/lib/workspaceStatus";
import {
  WORKSPACE_PR_STATE_ICON,
  WORKSPACE_PR_STATE_MOTION,
  deriveWorkspacePrAction,
  workspacePrActionInput,
} from "@/lib/workspacePrAction";
import { titleCaseWorkspace } from "@/lib/text";
import { fuzzyScore } from "@/lib/fuzzy";
import { runShellAction } from "@/lib/shellAction";
import ClientSwitcher from "./ClientSwitcher";
import PeekCard from "./PeekCard";
import { RepositoryPeek, WorkspacePeek } from "./SidebarPeek";
import {
  parseKeybindingOverrides,
  shortcutForAction,
  type ShortcutAction,
} from "@/lib/shortcuts";

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
      label: prefsStore.isPinned(name) ? "Unpin" : "Pin to top",
      run: () => prefsStore.togglePinned(name),
    },
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


// Left sidebar: nav group (Dashboard/History) + workspace list. Repositories are
// the top-level rows; each repo's workspaces are nested beneath it so a repo
// with no workspaces yet still appears. Each workspace row reads only its own
// store slice, so a status change on one workspace re-renders that row alone.

function keyHint(action: ShortcutAction): string | undefined {
  return shortcutForAction(action, parseKeybindingOverrides(prefsStore.state.keybindings));
}

function workspaceShortcut(name: string): ShortcutAction | undefined {
  const active = workspacesStore.state.order.filter(
    (candidate) => workspacesStore.row(candidate)?.status !== "archived",
  );
  const index = active.indexOf(name);
  return index >= 0 && index < 9 ? `switch-workspace-${index + 1}` as ShortcutAction : undefined;
}

function WorkspaceRow(props: { name: string }) {
  const row = () => workspacesStore.row(props.name);
  const selected = () => nav.selectedWorkspace() === props.name;
  const gitState = () => deriveWorkspacePrAction(workspacePrActionInput(row(), undefined));
  const hasDiffStats = () => ((row()?.additions ?? 0) > 0 || (row()?.deletions ?? 0) > 0);
  const activity = () => workspaceRowActivity(row() ?? {});
  return (
    <PeekCard
      content={<Show when={row()}>{(details) => <WorkspacePeek row={details()} />}</Show>}
    >
      {(peek) => (
        <button
          {...peek}
          class="workspace-row-shell"
          classList={{ selected: selected() }}
          data-shortcut={workspaceShortcut(props.name) ? keyHint(workspaceShortcut(props.name)!) : undefined}
          onClick={() => nav.selectWorkspace(props.name)}
          onContextMenu={(e) => openContextMenu(e, workspaceMenuItems(props.name))}
          onKeyDown={(e) => {
            if (typeof peek.onKeyDown === "function") peek.onKeyDown(e);
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              openContextMenuFromKeyboard(e, workspaceMenuItems(props.name));
            }
          }}
        >
          <span class="workspace-row-head">
        {/* Icon keys off `state`, not `action`: six situations share the
            `view` action and used to share one glyph, which made a merged PR
            indistinguishable from failing checks at a glance. */}
        <span
          class={`workspace-git-state workspace-git-state-${gitState().state}`}
          classList={{
            [`workspace-git-state-motion-${WORKSPACE_PR_STATE_MOTION[gitState().state]}`]:
              WORKSPACE_PR_STATE_MOTION[gitState().state] != null,
          }}
          title={gitState().title}
        >
          <Icon name={WORKSPACE_PR_STATE_ICON[gitState().state]} />
        </span>
        <span class="row-name" title={props.name}>{titleCaseWorkspace(props.name)}</span>
        {/* A blocked agent is otherwise indistinguishable from a working one
            in this list, which is how a session sits parked for minutes. */}
        <Show when={prefsStore.isPinned(props.name)}>
          <span class="workspace-row-indicator workspace-row-pinned" title="Pinned">
            <Icon name="arrow-up" />
          </span>
        </Show>
        <Show when={row()?.awaitingInput}>
          <span
            class="workspace-row-indicator workspace-row-awaiting"
            title="An agent is waiting for your answer"
          >
            <Icon name="alert" />
          </span>
        </Show>
        {/* One indicator for "something is live here", not a row of unlabelled
            glyphs. A PR badge used to sit here too, duplicating the PR-state
            icon at the start of the row. */}
        <Show when={activity()}>
          {(live) => (
            <span class="workspace-row-live" title={live().title}>
              <span class="workspace-row-live-dot" />
              <Show when={live().count > 1}>
                <span class="workspace-row-live-count">{live().count}</span>
              </Show>
            </span>
          )}
        </Show>
        <Show when={hasDiffStats()}>
          <span class="workspace-row-diff">
            <span class="workspace-row-additions">+{row()?.additions ?? 0}</span>
            <span class="workspace-row-deletions">-{row()?.deletions ?? 0}</span>
          </span>
        </Show>
          </span>
        </button>
      )}
    </PeekCard>
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

// Sidebar filter. Module-level so the project groups and the input share it
// without threading a prop through every row.
const [workspaceFilter, setWorkspaceFilter] = createSignal("");

/** Match on the workspace name and its branch — people search for either. */
function matchesFilter(name: string, query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true;
  const row = workspacesStore.row(name);
  return (
    fuzzyScore(trimmed, name) !== null ||
    (row?.branch ? fuzzyScore(trimmed, row.branch) !== null : false)
  );
}

function ProjectGroup(props: { repo: string }) {
  const names = () => {
    const all = workspacesStore.state.order.filter(
      (name) =>
        workspacesStore.row(name)?.repository === props.repo &&
        matchesFilter(name, workspaceFilter()),
    );
    // Pinned first, otherwise the daemon's order. Stable so the list does not
    // reshuffle while an agent updates a row.
    const pinned = all.filter((name) => prefsStore.isPinned(name));
    const rest = all.filter((name) => !prefsStore.isPinned(name));
    return [...pinned, ...rest];
  };
  return (
    <div class="project-group">
      <PeekCard
        content={
          <Show when={repositoriesStore.row(props.repo)}>
            {(row) => <RepositoryPeek row={row()} />}
          </Show>
        }
      >
        {(peek) => (
          <div
            {...peek}
            class="project-row"
            tabIndex={0}
            onContextMenu={(e) => openContextMenu(e, repoMenuItems(props.repo))}
            onKeyDown={(e) => {
              if (typeof peek.onKeyDown === "function") peek.onKeyDown(e);
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
              data-shortcut={keyHint("new-workspace")}
              onClick={() => dialogs.open({ kind: "create-workspace", repository: props.repo })}
            >
              <Icon name="plus" />
            </button>
          </div>
        )}
      </PeekCard>
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
          data-shortcut={keyHint("nav-back")}
          onClick={() => nav.back()}
          title="Back"
        >
          <Icon name="arrow-left" />
        </button>
        <button
          class="ui-button-icon"
          disabled={!nav.canForward()}
          data-shortcut={keyHint("nav-forward")}
          onClick={() => nav.forward()}
          title="Forward"
        >
          <Icon name="arrow-right" />
        </button>
        <button class="ui-button-icon" data-shortcut={keyHint("toggle-sidebar")} onClick={props.onToggle} title="Hide sidebar">
          <Icon name="panel-left" />
        </button>
      </div>

      <ClientSwitcher />

      <div class="sidebar-nav-group">
        <button
          class="sidebar-nav-button"
          classList={{ active: nav.activePage() === "dashboard" }}
          data-shortcut={keyHint("goto-dashboard")}
          onClick={() => nav.goToPage("dashboard")}
        >
          <Icon name="layout-dashboard" class="sidebar-nav-icon" />
          <span class="sidebar-nav-label">Dashboard</span>
        </button>
        <button
          class="sidebar-nav-button"
          classList={{ active: nav.activePage() === "history" }}
          data-shortcut={keyHint("goto-history")}
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
            data-shortcut={keyHint("add-project")}
            onClick={() => dialogs.open({ kind: "add-project" })}
          >
            <Icon name="plus" />
          </button>
      </div>

      <label class="workspace-search">
        {/* Was a document glyph, which read as "file" rather than "search". */}
        <Icon name="search" class="workspace-search-icon" />
        <input
          value={workspaceFilter()}
          placeholder="Filter workspaces"
          onInput={(e) => setWorkspaceFilter(e.currentTarget.value)}
        />
        <Show when={workspaceFilter()}>
          <button
            class="ui-button-icon"
            title="Clear filter"
            onClick={() => setWorkspaceFilter("")}
          >
            <Icon name="x" />
          </button>
        </Show>
      </label>

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
          data-shortcut={keyHint("goto-settings")}
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
          // There is no second fixed-width column left to measure: the region
          // model's right panel is gone and everything to the right of the
          // sidebar is one workbench that divides itself by ratio, each split
          // clamped in pixels against its children's minimums. So the only
          // reservation this drag owes is the workbench's own floor, which is
          // `panelDragMax`'s `centerMin` default. (It used to measure
          // `.ws-right-panel`, a selector nothing has emitted since the region
          // model was deleted — it always returned 0.)
          max={() =>
            panelDragMax({
              viewportWidth: window.innerWidth,
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
