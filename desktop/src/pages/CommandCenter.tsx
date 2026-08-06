import { For, Match, Show, Switch, createSignal } from "solid-js";
import { nav, workspacesStore, repositoriesStore } from "@/store";
import { openExternal } from "@/bridge/client";
import { titleCaseWorkspace } from "@/lib/text";
import ChatSurface from "./ChatSurface";
import WorkspaceFiles from "./WorkspaceFiles";
import { ChangesRows } from "./WorkspaceChanges";
import WorkspacePrBar from "./WorkspacePrBar";
import TerminalDock from "./TerminalDock";
import {
  ChecksPanel,
  ReviewPanel,
  TodosPanel,
  CheckpointsPanel,
  ProcessesPanel,
} from "./WorkspaceTabs";
import type { RightPanelTab } from "@/store/nav";
import { openFileInCenter } from "./openFileBridge";
import ResizeHandle from "@/components/ResizeHandle";
import { createPersistedWidth } from "@/lib/persistedWidth";

const RIGHT_MIN = 280;
const RIGHT_MAX = 640;

// Right-panel tabs. Browse/Changes lead (the common review flow); the rest
// restore the GTK command-center panels (Checks/Review/Todos/Checkpoints/
// Processes) that were defined but previously unreachable in the Electron UI.
const RIGHT_TABS: { tab: RightPanelTab; label: string }[] = [
  { tab: "browse", label: "Browse" },
  { tab: "changes", label: "Changes" },
  { tab: "checks", label: "Checks" },
  { tab: "review", label: "Review" },
  { tab: "todos", label: "Todos" },
  { tab: "checkpoints", label: "Checkpoints" },
  { tab: "processes", label: "Processes" },
];

// Workspace command center — port of workspace_command_center.rs. Three regions:
//   center  : draggable top bar (repo > branch) + chat/file surface + composer
//   right   : PR status bar (top) / Browse|Changes (mid) / terminals (bottom)
// The center holds ONLY chats + open files; everything workflow-related lives in
// the right column, matching the GTK active-workspace layout.

function TopBar(props: {
  workspace: string;
  onOpenEditor: () => void;
  rightCollapsed: boolean;
  onToggleRight: () => void;
}) {
  const row = () => workspacesStore.row(props.workspace);
  return (
    <div class="ws-topbar">
      <div class="ws-topbar-breadcrumb">
        <span class="ws-topbar-repo">{titleCaseWorkspace(props.workspace)}</span>
        <Show when={row()?.branch}>
          <span class="ws-topbar-sep">›</span>
          <span class="ws-topbar-branch">{row()!.branch}</span>
        </Show>
      </div>
      <div class="ws-topbar-actions">
        <button class="ui-button-icon ws-topbar-btn" title="Open in editor" onClick={props.onOpenEditor}>
          ⧉
        </button>
        <button
          class="ui-button-icon ws-topbar-btn"
          title={props.rightCollapsed ? "Show right panel" : "Collapse right panel"}
          onClick={props.onToggleRight}
        >
          {props.rightCollapsed ? "⇤" : "⇥"}
        </button>
      </div>
    </div>
  );
}

function RightPanel(props: { workspace: string }) {
  const [width, setWidth] = createPersistedWidth("rightPanel.width", 340, RIGHT_MIN, RIGHT_MAX);
  return (
    <aside class="ws-right-panel" style={{ width: `${width()}px`, "flex-basis": `${width()}px` }}>
      <ResizeHandle edge="left" width={width} min={RIGHT_MIN} max={RIGHT_MAX} onChange={setWidth} />
      <WorkspacePrBar workspace={props.workspace} />
      <div class="ws-right-mid">
        <div class="command-center-strip ws-right-tabs">
          <For each={RIGHT_TABS}>
            {(t) => (
              <button
                class="nav-button"
                classList={{ "nav-button-active": nav.rightPanelTab() === t.tab }}
                onClick={() => nav.setRightPanelTab(t.tab)}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>
        <div class="ws-right-body">
          <Switch>
            <Match when={nav.rightPanelTab() === "browse"}>
              <WorkspaceFiles
                workspace={props.workspace}
                openFile={(p) => openFileInCenter(props.workspace, p)}
              />
            </Match>
            <Match when={nav.rightPanelTab() === "changes"}>
              <ChangesRows
                workspace={props.workspace}
                openFile={(p) => openFileInCenter(props.workspace, p)}
              />
            </Match>
            <Match when={nav.rightPanelTab() === "checks"}>
              <ChecksPanel workspace={props.workspace} />
            </Match>
            <Match when={nav.rightPanelTab() === "review"}>
              <ReviewPanel workspace={props.workspace} />
            </Match>
            <Match when={nav.rightPanelTab() === "todos"}>
              <TodosPanel workspace={props.workspace} />
            </Match>
            <Match when={nav.rightPanelTab() === "checkpoints"}>
              <CheckpointsPanel workspace={props.workspace} />
            </Match>
            <Match when={nav.rightPanelTab() === "processes"}>
              <ProcessesPanel workspace={props.workspace} />
            </Match>
          </Switch>
        </div>
      </div>
      <TerminalDock workspace={props.workspace} />
    </aside>
  );
}

export default function CommandCenter() {
  const workspace = () => nav.selectedWorkspace() ?? "";
  const [rightCollapsed, setRightCollapsed] = createSignal(false);

  function openEditor(ws: string) {
    const repo = workspacesStore.row(ws)?.repository;
    const root = repo ? repositoriesStore.row(repo)?.rootPath : undefined;
    if (root) void openExternal(root);
  }

  return (
    <Show
      when={workspace()}
      fallback={<div class="empty-state">Select a workspace from the sidebar.</div>}
    >
      {(ws) => (
        <div class="ws-command-center page-shell">
          <div class="ws-center">
            <TopBar
              workspace={ws()}
              onOpenEditor={() => openEditor(ws())}
              rightCollapsed={rightCollapsed()}
              onToggleRight={() => setRightCollapsed((c) => !c)}
            />
            <div class="ws-center-content">
              <ChatSurface workspace={ws()} />
            </div>
          </div>
          <Show when={!rightCollapsed()}>
            <RightPanel workspace={ws()} />
          </Show>
        </div>
      )}
    </Show>
  );
}
