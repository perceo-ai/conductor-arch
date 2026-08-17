import { For, Match, Show, Switch, createMemo, createResource, createSignal } from "solid-js";
import { nav, workspacesStore, repositoriesStore } from "@/store";
import { openExternal, openWorkspaceApp, send } from "@/bridge/client";
import { titleCaseWorkspace } from "@/lib/text";
import { STATUS_COLOR } from "@/lib/workspaceStatus";
import { deriveWorkspaceBriefing, workspaceBriefingStatusLabel } from "@/lib/workspaceBriefing";
import type { ArchcarChecksSummary } from "@/bridge/protocol";
import ChatSurface from "./ChatSurface";
import WorkspaceFiles from "./WorkspaceFiles";
import { ChangesRows } from "./WorkspaceChanges";
import TerminalDock from "./TerminalDock";
import WorkspacePrBar from "./WorkspacePrBar";
import { ChecksPanel, ReviewPanel } from "./WorkspaceTabs";
import { PRODUCT_RIGHT_PANEL_TABS, type RightPanelTab } from "@/lib/rightPanelTabs";
import { openFileInCenter } from "./openFileBridge";
import ResizeHandle from "@/components/ResizeHandle";
import { createPersistedWidth } from "@/lib/persistedWidth";
import Icon from "@/components/Icon";
import { openContextMenuAt, type ContextMenuItem } from "@/components/ContextMenu";
import { WORKSPACE_OPEN_APPS } from "@/lib/workspaceOpenApps";

const RIGHT_MIN = 260;
const RIGHT_MAX = 440;

// Right-panel tabs: a quiet inspector beside the chat. Deeper intelligence
// records remain in the data model, but they are not promoted as peer surfaces.
const RIGHT_TABS: { tab: RightPanelTab; label: string }[] = PRODUCT_RIGHT_PANEL_TABS.map(
  (tab) => ({ tab: tab.id, label: tab.label }),
);

// Workspace command center. Chat is the primary surface; the right side is a
// contextual inspector and the terminal dock is utility output.

function TopBar(props: {
  workspace: string;
  rightCollapsed: boolean;
  onToggleRight: () => void;
  checks?: ArchcarChecksSummary;
}) {
  const row = () => workspacesStore.row(props.workspace);
  const briefing = () => deriveWorkspaceBriefing(row(), props.checks);
  const repoRoot = () => {
    const repo = row()?.repository;
    return repo ? repositoriesStore.row(repo)?.rootPath : undefined;
  };
  const openItems = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    const root = repoRoot();
    if (root) {
      items.push({ label: "Open in Finder", icon: "folder", run: () => void openExternal(root) });
      for (const app of WORKSPACE_OPEN_APPS) {
        items.push({
          label: `Open in ${app.label}`,
          iconSrc: app.logoSrc,
          iconAlt: app.label,
          run: () => void openWorkspaceApp({ rootPath: root, appId: app.id }),
        });
      }
    }
    const prUrl = row()?.prUrl;
    if (prUrl) items.push({ label: "Open pull request", icon: "external", run: () => void openExternal(prUrl) });
    return items;
  };
  function openMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenuAt(rect.left, rect.bottom + 4, openItems());
  }
  return (
    <div class="ws-topbar">
      <div class="ws-topbar-breadcrumb">
        <span
          class="ws-topbar-status-dot"
          style={{ "background-color": STATUS_COLOR[briefing().status] }}
          aria-label={workspaceBriefingStatusLabel(briefing())}
        />
        <span class="ws-topbar-repo">{titleCaseWorkspace(props.workspace)}</span>
        <span class="ws-topbar-sep">&gt;</span>
        <span class="ws-topbar-branch">{row()?.branch ?? "branch loading"}</span>
      </div>
      <div class="ws-topbar-actions">
        <button class="ws-open-menu-button ws-topbar-btn" title="Open" onClick={openMenu}>
          <Icon name="external" />
          <Icon name="chevron-down" class="ws-open-menu-chevron" />
        </button>
        <button
          class="ui-button-icon ws-topbar-btn"
          title={props.rightCollapsed ? "Show right panel" : "Collapse right panel"}
          onClick={props.onToggleRight}
        >
          <Icon name={props.rightCollapsed ? "panel-left" : "panel-right"} />
        </button>
      </div>
    </div>
  );
}

function RightPanel(props: { workspace: string }) {
  const [width, setWidth] = createPersistedWidth("rightPanel.width", 300, RIGHT_MIN, RIGHT_MAX);
  const row = () => workspacesStore.row(props.workspace);
  const tabCount = (tab: RightPanelTab) => {
    const r = row();
    if (!r) return "";
    if (tab === "changes" && r.changedFiles > 0) return String(r.changedFiles);
    if (tab === "checks" && (r.activeSessions > 0 || r.runRunning)) {
      return r.runRunning ? "run" : String(r.activeSessions);
    }
    return "";
  };
  return (
    <aside class="ws-right-panel" style={{ width: `${width()}px`, "flex-basis": `${width()}px` }}>
      <ResizeHandle edge="left" width={width} min={RIGHT_MIN} max={RIGHT_MAX} onChange={setWidth} />
      <div class="ws-right-mid">
        <div class="ws-right-topbar">
          <WorkspacePrBar workspace={props.workspace} />
        </div>
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
            <Match when={nav.rightPanelTab() === "files"}>
              <WorkspaceFiles
                workspace={props.workspace}
                rootPath={row()?.path}
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
