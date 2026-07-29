import { For, Match, Show, Switch } from "solid-js";
import { nav, workspacesStore } from "@/store";
import type { WorkspaceTab } from "@/store/nav";
import { titleCaseWorkspace } from "@/lib/text";
import ChatSurface from "./ChatSurface";
import WorkspaceFiles from "./WorkspaceFiles";
import ChangesTab, { ChangesRows } from "./WorkspaceChanges";
import { ChecksPanel, CheckpointsPanel, ProcessesPanel, ReviewPanel, TodosPanel } from "./WorkspaceTabs";
import TerminalPanel from "./TerminalPanel";

// Workspace command center — port of workspace_command_center.rs. Header +
// workspace tab strip + a center/right split (right panel is the 340px fixed
// browse/changes pane). Only the Chats tab is fully wired this phase; the other
// tabs render labeled placeholders until their backends land.

const TABS: { tab: WorkspaceTab; label: string }[] = [
  { tab: "chats", label: "Chats" },
  { tab: "changes", label: "Changes" },
  { tab: "review", label: "Review" },
  { tab: "checkpoints", label: "Checkpoints" },
  { tab: "checks", label: "Checks" },
  { tab: "todos", label: "Todos" },
  { tab: "processes", label: "Processes" },
  { tab: "terminal", label: "Terminal" },
];

function Placeholder(props: { label: string }) {
  return <div class="empty-state">{props.label} — later phase.</div>;
}

function RightPanel(props: { workspace: string }) {
  return (
    <aside class="ws-right-panel">
      <div class="command-center-strip">
        <button
          class="nav-button"
          classList={{ "nav-button-active": nav.rightPanelTab() === "browse" }}
          onClick={() => nav.setRightPanelTab("browse")}
        >
          Browse
        </button>
        <button
          class="nav-button"
          classList={{ "nav-button-active": nav.rightPanelTab() === "changes" }}
          onClick={() => nav.setRightPanelTab("changes")}
        >
          Changes
        </button>
      </div>
      <div class="ws-right-body">
        <Show
          when={nav.rightPanelTab() === "browse"}
          fallback={<ChangesRows workspace={props.workspace} />}
        >
          <WorkspaceFiles workspace={props.workspace} />
        </Show>
      </div>
    </aside>
  );
}

export default function CommandCenter() {
  const workspace = () => nav.selectedWorkspace() ?? "";
  const activeLabel = () => TABS.find((t) => t.tab === nav.activeWorkspaceTab())?.label ?? "";

  return (
    <Show
      when={workspace()}
      fallback={<div class="empty-state">Select a workspace from the sidebar.</div>}
    >
      {(ws) => {
        const row = () => workspacesStore.row(ws());
        return (
          <div class="ws-command-center page-shell">
            <div class="ws-center">
              <div class="ws-header page-header">
                <div class="ws-header-title">{titleCaseWorkspace(ws())}</div>
                <Show when={row()}>{(r) => <div class="ws-header-branch">{r().branch}</div>}</Show>
              </div>

              <div class="ws-tab-bar ws-main-tabs">
                <For each={TABS}>
                  {(t) => (
                    <button
                      class="ws-tab-shell"
                      classList={{ "ws-tab-active": nav.activeWorkspaceTab() === t.tab }}
                      onClick={() => nav.selectWorkspaceTab(t.tab)}
                    >
                      <span class="ws-tab-label">{t.label}</span>
                    </button>
                  )}
                </For>
              </div>
              <div class="ws-tab-sep" />

              <div class="ws-center-content">
                <Switch fallback={<Placeholder label={activeLabel()} />}>
                  <Match when={nav.activeWorkspaceTab() === "chats"}>
                    <ChatSurface workspace={ws()} />
                  </Match>
                  <Match when={nav.activeWorkspaceTab() === "changes"}>
                    <ChangesTab workspace={ws()} />
                  </Match>
                  <Match when={nav.activeWorkspaceTab() === "todos"}>
                    <TodosPanel workspace={ws()} />
                  </Match>
                  <Match when={nav.activeWorkspaceTab() === "checkpoints"}>
                    <CheckpointsPanel workspace={ws()} />
                  </Match>
                  <Match when={nav.activeWorkspaceTab() === "processes"}>
                    <ProcessesPanel workspace={ws()} />
                  </Match>
                  <Match when={nav.activeWorkspaceTab() === "review"}>
                    <ReviewPanel workspace={ws()} />
                  </Match>
                  <Match when={nav.activeWorkspaceTab() === "checks"}>
                    <ChecksPanel workspace={ws()} />
                  </Match>
                  <Match when={nav.activeWorkspaceTab() === "terminal"}>
                    <TerminalPanel workspace={ws()} />
                  </Match>
                </Switch>
              </div>
            </div>

            <RightPanel workspace={ws()} />
          </div>
        );
      }}
    </Show>
  );
}
