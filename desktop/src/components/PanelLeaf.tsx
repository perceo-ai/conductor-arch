import { For, Show, Suspense, createMemo } from "solid-js";
import { visiblePanelIds, type LayoutLeaf, type PanelId } from "@/lib/layout";
import { panelDescriptor } from "@/lib/panelRegistry";
import { layoutStore } from "@/store/layout";
import { workspacesStore } from "@/store/workspaces";
import { ReviewPromptButton } from "@/pages/WorkspaceTabs";
import Icon from "./Icon";
import { openContextMenu, openContextMenuFromKeyboard, type ContextMenuItem } from "./ContextMenu";
import { announceLayout } from "./LayoutControls";
import { usePanelDnd } from "./PanelDnd";
import { configuredShortcut } from "@/lib/configuredShortcut";
import type { ShortcutAction } from "@/lib/shortcuts";

const PANEL_SHORTCUTS: Partial<Record<PanelId, ShortcutAction>> = {
  changes: "show-changes",
  files: "show-files",
  checks: "show-checks",
  summary: "show-summary",
  terminal: "toggle-terminal",
};

function domId(leafId: string, panel: PanelId, suffix: string) {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `workbench-${safe(leafId)}-${safe(panel)}-${suffix}`;
}

/**
 * One leaf of the split tree: a tab bar plus the active panel's body.
 *
 * DOM contract for the drag layer (PanelDndController measures this, it does
 * not own it): the root carries `data-leaf-id`, the tab bar is the leaf's own
 * `[data-tab-bar]` child — so its height can be measured rather than hardcoded
 * — and each tab shell carries `data-tab-index`.
 */
export default function PanelLeaf(props: { leaf: LayoutLeaf; workspace: string }) {
  const dnd = usePanelDnd();
  const panels = () => props.leaf.panels;
  const activeId = () => panels()[Math.max(0, Math.min(props.leaf.active, panels().length - 1))];
  const activeDescriptor = () => (activeId() ? panelDescriptor(activeId()) : undefined);
  const row = () => workspacesStore.row(props.workspace);
  const tabCount = (id: PanelId) => {
    const workspace = row();
    if (!workspace) return "";
    if (id === "summary" && (workspace.openTasks > 0 || workspace.blockedTasks > 0)) {
      return String(workspace.blockedTasks > 0 ? workspace.blockedTasks : workspace.openTasks);
    }
    if (id === "changes" && workspace.changedFiles > 0) return String(workspace.changedFiles);
    if (id === "checks" && (workspace.activeSessions > 0 || workspace.runRunning)) {
      return workspace.runRunning ? "run" : String(workspace.activeSessions);
    }
    return "";
  };
  // A compact leaf holding a single panel is chrome-free; anything else needs a
  // strip to choose between its tabs. A collapsed leaf is nothing *but* the
  // strip, so it always renders one.
  const showTabs = createMemo(() => props.leaf.display === "tabs" || panels().length > 1);
  const showTabBar = () => showTabs() || props.leaf.collapsed;

  function activate(id: PanelId) {
    layoutStore.activatePanel(id);
  }

  function focusTab(index: number) {
    const list = panels();
    const id = list[Math.max(0, Math.min(index, list.length - 1))];
    if (!id) return;
    activate(id);
    queueMicrotask(() => document.getElementById(domId(props.leaf.id, id, "tab"))?.focus());
  }

  function navigateTabs(event: KeyboardEvent, index: number) {
    const last = panels().length - 1;
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    if (next === undefined) return;
    event.preventDefault();
    focusTab(next);
  }

  /** The last panel on screen has nowhere to go — closing it would blank the workbench. */
  function canHide(id: PanelId) {
    return visiblePanelIds(layoutStore.layout()).filter((candidate) => candidate !== id).length > 0;
  }

  function panelMenu(id: PanelId): ContextMenuItem[] {
    const descriptor = panelDescriptor(id);
    if (!descriptor || !canHide(id)) return [];
    return [
      {
        label: `Hide ${descriptor.title}`,
        run: () => {
          layoutStore.removePanel(id);
          announceLayout(`${descriptor.title} hidden.`);
        },
      },
    ];
  }

  return (
    <section
      class="workbench-leaf"
      classList={{
        "workbench-leaf-collapsed": props.leaf.collapsed,
        "workbench-leaf-compact": !showTabs(),
      }}
      data-leaf-id={props.leaf.id}
      tabIndex={-1}
      onFocusIn={() => layoutStore.setFocusedLeaf(props.leaf.id)}
    >
      <Show when={showTabBar()}>
        <div
          class="workbench-tablist command-center-strip ws-right-tabs"
          classList={{ "workbench-tablist-single": panels().length === 1 }}
          data-tab-bar=""
          role="tablist"
          aria-label="Workbench panels"
        >
          <For each={panels()}>
            {(id, index) => {
              const descriptor = panelDescriptor(id);
              if (!descriptor) return null;
              const selected = () => activeId() === id;
              return (
                <div
                  class="workbench-tab-shell"
                  data-panel-id={id}
                  data-tab-index={index()}
                  onContextMenu={(event) => openContextMenu(event, panelMenu(id))}
                >
                  <button
                    id={domId(props.leaf.id, id, "tab")}
                    class="nav-button workbench-tab"
                    classList={{ "nav-button-active": selected() }}
                    role="tab"
                    aria-selected={selected()}
                    aria-controls={domId(props.leaf.id, id, "panel")}
                    tabIndex={selected() ? 0 : -1}
                    data-shortcut={PANEL_SHORTCUTS[id] ? configuredShortcut(PANEL_SHORTCUTS[id]!) : undefined}
                    onClick={() => activate(id)}
                    onPointerDown={(event) => dnd.begin(event, id)}
                    onKeyDown={(event) => {
                      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                        openContextMenuFromKeyboard(event, panelMenu(id));
                      } else {
                        navigateTabs(event, index());
                      }
                    }}
                  >
                    <span>{descriptor.title}</span>
                    <Show when={tabCount(id)}>
                      {(count) => <span class="nav-button-count">{count()}</span>}
                    </Show>
                  </button>
                  <Show when={canHide(id)}>
                    <button
                      class="workbench-tab-close"
                      aria-label={`Hide ${descriptor.title}`}
                      title={`Hide ${descriptor.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        layoutStore.removePanel(id);
                        announceLayout(`${descriptor.title} hidden.`);
                      }}
                    >
                      <Icon name="x" />
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>
          <Show when={panels().includes("changes")}>
            <ReviewPromptButton workspace={props.workspace} />
          </Show>
        </div>
      </Show>

      <Show when={!props.leaf.collapsed}>
        <Show when={activeDescriptor()} keyed>
          {(descriptor) => {
            const Component = descriptor.component;
            return (
              <div
                id={domId(props.leaf.id, descriptor.id, "panel")}
                class="workbench-panel-body ws-right-body"
                role={showTabBar() ? "tabpanel" : undefined}
                aria-labelledby={showTabBar() ? domId(props.leaf.id, descriptor.id, "tab") : undefined}
                aria-label={showTabBar() ? undefined : descriptor.title}
                data-panel-id={descriptor.id}
                data-panel-kind={descriptor.kind}
              >
                <Suspense><Component workspace={props.workspace} /></Suspense>
              </div>
            );
          }}
        </Show>
      </Show>
    </section>
  );
}
