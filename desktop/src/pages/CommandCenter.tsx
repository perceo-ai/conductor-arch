import { For, Match, Show, Switch, createMemo, createResource, createSignal } from "solid-js";
import { nav, workspacesStore, repositoriesStore } from "@/store";
import { openExternal, send } from "@/bridge/client";
import { titleCaseWorkspace } from "@/lib/text";
import { STATUS_COLOR } from "@/lib/workspaceStatus";
import { deriveWorkspaceBriefing, workspaceBriefingStatusLabel } from "@/lib/workspaceBriefing";
import type { ArchcarChecksSummary } from "@/bridge/protocol";
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
  TimelinePanel,
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
  { tab: "timeline", label: "Timeline" },
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
  checks?: ArchcarChecksSummary;
}) {
  const row = () => workspacesStore.row(props.workspace);
  const briefing = () => deriveWorkspaceBriefing(row(), props.checks);
  return (
    <div class="ws-topbar">
      <div class="ws-topbar-breadcrumb">
        <span
          class="ws-topbar-status-dot"
          style={{ "background-color": STATUS_COLOR[briefing().status] }}
          aria-label={workspaceBriefingStatusLabel(briefing())}
        />
        <span class="ws-topbar-repo">{titleCaseWorkspace(props.workspace)}</span>
        <Show when={row()?.branch}>
          <span class="ws-topbar-sep">›</span>
          <span class="ws-topbar-branch">{row()!.branch}</span>
        </Show>
        <span class="ws-topbar-summary">{briefing().topbarSummary}</span>
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

function WorkspaceBriefing(props: { workspace: string; checks?: ArchcarChecksSummary }) {
  const row = () => workspacesStore.row(props.workspace);
  const briefing = () => deriveWorkspaceBriefing(row(), props.checks);

  return (
    <div class="ws-briefing" aria-label="Workspace briefing">
      <div class="ws-briefing-main">
        <span class="ws-briefing-kicker">Next</span>
        <span class="ws-briefing-action">{briefing().nextAction}</span>
      </div>
      <div class="ws-briefing-tiles">
        <For each={briefing().tiles}>
          {(tile) => (
            <button
              class="ws-briefing-tile"
              classList={{ [`ws-briefing-${tile.tone}`]: true }}
              onClick={() => {
                if (tile.label === "Review") nav.setRightPanelTab("checks");
                if (tile.label === "Changes") nav.setRightPanelTab("changes");
                if (tile.label === "Agents" || tile.label === "Scripts")
                  nav.setRightPanelTab("processes");
                if (tile.label === "Checks") nav.setRightPanelTab("checks");
              }}
            >
              <span class="ws-briefing-label">{tile.label}</span>
              <span class="ws-briefing-value">{tile.value}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

function RightPanel(props: { workspace: string }) {
  const [width, setWidth] = createPersistedWidth("rightPanel.width", 340, RIGHT_MIN, RIGHT_MAX);
  const row = () => workspacesStore.row(props.workspace);
  const tabCount = (tab: RightPanelTab) => {
    const r = row();
    if (!r) return "";
    if (tab === "changes" && r.changedFiles > 0) return String(r.changedFiles);
    if (tab === "todos" && r.openTodos > 0) return String(r.openTodos);
    if (tab === "processes" && (r.activeSessions > 0 || r.runRunning)) {
      return r.runRunning ? "run" : String(r.activeSessions);
    }
    if (tab === "checks" && r.prNumber != null) return "PR";
    return "";
  };
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
                <span>{t.label}</span>
                <Show when={tabCount(t.tab)}>
                  {(count) => <span class="nav-button-count">{count()}</span>}
                </Show>
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
            <Match when={nav.rightPanelTab() === "timeline"}>
              <TimelinePanel workspace={props.workspace} />
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
  const [checks] = createResource(
    workspace,
    async (ws): Promise<ArchcarChecksSummary | undefined> => {
      if (!ws) return undefined;
      try {
        const res = await send({ type: "get_checks_summary", workspace: ws });
        return res.type === "checks_summary" ? res.summary : undefined;
      } catch {
        return undefined;
      }
    },
  );
  const currentChecks = createMemo(() => checks());

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
              checks={currentChecks()}
              onOpenEditor={() => openEditor(ws())}
              rightCollapsed={rightCollapsed()}
              onToggleRight={() => setRightCollapsed((c) => !c)}
            />
            <WorkspaceBriefing workspace={ws()} checks={currentChecks()} />
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
