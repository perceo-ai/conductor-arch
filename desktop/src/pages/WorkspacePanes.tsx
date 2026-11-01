import { For, Index, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { nav, workspacesStore } from "@/store";
import type { TabGroup, SplitDirection } from "@/lib/workspaceTabs";
import { titleCaseWorkspace } from "@/lib/text";
import Icon from "@/components/Icon";
import { openContextMenuAt, type ContextMenuItem } from "@/components/ContextMenu";
import CommandCenter from "./CommandCenter";
import { PaneProvider, paneFor } from "./paneContext";

// The workspace page: a browser-style tab strip over the workspace view, split
// into at most two panes. Each pane is a tab group with its own active
// workspace; the focused one is the app's selected workspace, so the sidebar,
// shortcuts, and every action keep acting on "the workspace on screen".
//
// Tabs move by drag: onto another strip to move, onto the right or bottom edge
// of a lone pane to split. The tab menu offers the same moves for keyboard and
// trackpad users.

const TAB_MIME = "application/x-archductor-workspace-tab";

// The tab being dragged. dataTransfer cannot be read during dragover, so the
// drop zones learn what is in flight from here.
const [draggingTab, setDraggingTab] = createSignal<string | null>(null);

function tabMenu(name: string, groupIndex: number): ContextMenuItem[] {
  const tabs = nav.workspaceTabs();
  const group = tabs.groups[groupIndex];
  const items: ContextMenuItem[] = [];
  if (tabs.groups.length > 1) {
    items.push({
      label: "Move to Other Pane",
      icon: "arrow-right",
      run: () => nav.splitWorkspaceTab(name, tabs.direction),
    });
  } else if (group && group.tabs.length > 1) {
    items.push(
      { label: "Split Right", icon: "panel-right", run: () => nav.splitWorkspaceTab(name, "right") },
      { label: "Split Down", run: () => nav.splitWorkspaceTab(name, "down") },
    );
  }
  items.push({ label: "Close Tab", icon: "x", run: () => nav.closeWorkspaceTab(name) });
  if (group && group.tabs.length > 1) {
    items.push({ label: "Close Other Tabs", run: () => nav.closeOtherWorkspaceTabs(name) });
  }
  return items;
}

function WorkspaceTab(props: { name: string; groupIndex: number; active: boolean; focusedPane: boolean }) {
  const row = () => workspacesStore.row(props.name);
  const working = () => (row()?.activeSessions ?? 0) > 0;
  function activate() {
    nav.selectWorkspace(props.name);
  }
  return (
    <div
      class="ws-pane-tab"
      classList={{ "ws-pane-tab-active": props.active, "ws-pane-tab-focused": props.active && props.focusedPane }}
      role="tab"
      aria-selected={props.active}
      tabIndex={0}
      draggable={true}
      data-workspace-tab={props.name}
      title={row()?.branch ? `${titleCaseWorkspace(props.name)} · ${row()!.branch}` : titleCaseWorkspace(props.name)}
      onClick={activate}
      onAuxClick={(e) => {
        // Middle-click closes, as in a browser.
        if (e.button !== 1) return;
        e.preventDefault();
        nav.closeWorkspaceTab(props.name);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          openContextMenuAt(rect.left, rect.bottom + 4, tabMenu(props.name, props.groupIndex));
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenuAt(e.clientX, e.clientY, tabMenu(props.name, props.groupIndex));
      }}
      onDragStart={(e) => {
        e.dataTransfer?.setData(TAB_MIME, props.name);
        e.dataTransfer?.setData("text/plain", props.name);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        setDraggingTab(props.name);
      }}
      onDragEnd={() => setDraggingTab(null)}
    >
      <Show when={working()}>
        <span class="ws-pane-tab-dot" aria-label="Agent running" />
      </Show>
      <span class="ws-pane-tab-label">{titleCaseWorkspace(props.name)}</span>
      <button
        class="ws-pane-tab-close"
        title="Close tab"
        aria-label={`Close ${titleCaseWorkspace(props.name)}`}
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          nav.closeWorkspaceTab(props.name);
        }}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

/** Index a drop lands at: before the tab under the pointer, or at the end. */
function dropIndex(strip: HTMLElement, clientX: number): number {
  const tabs = [...strip.querySelectorAll<HTMLElement>("[data-workspace-tab]")];
  const at = tabs.findIndex((tab) => {
    const rect = tab.getBoundingClientRect();
    return clientX < rect.left + rect.width / 2;
  });
  return at < 0 ? tabs.length : at;
}

function TabStrip(props: { group: TabGroup; index: number; focused: boolean }) {
  let strip: HTMLDivElement | undefined;
  const [dropOver, setDropOver] = createSignal(false);
  return (
    <div
      class="ws-pane-tabbar"
      classList={{ "ws-pane-tabbar-drop": dropOver() }}
      onDragOver={(e) => {
        if (!draggingTab()) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        setDropOver(true);
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        setDropOver(false);
        const name = e.dataTransfer?.getData(TAB_MIME) || draggingTab();
        setDraggingTab(null);
        if (!name || !strip) return;
        e.preventDefault();
        nav.moveWorkspaceTab(name, props.index, dropIndex(strip, e.clientX));
      }}
    >
      <div class="ws-pane-tabs" role="tablist" ref={strip}>
        <For each={props.group.tabs}>
          {(name) => (
            <WorkspaceTab
              name={name}
              groupIndex={props.index}
              active={props.group.active === name}
              focusedPane={props.focused}
            />
          )}
        </For>
      </div>
    </div>
  );
}

/**
 * Drop targets over a pane while a tab is dragged. A lone pane offers its right
 * and bottom edges to split; with the view already split, the other pane takes
 * the tab whole.
 */
function DropZones(props: { group: TabGroup; index: number }) {
  const [over, setOver] = createSignal<SplitDirection | "move" | null>(null);
  const split = () => nav.workspaceTabs().groups.length > 1;
  const show = () => {
    const name = draggingTab();
    if (!name) return false;
    if (split()) return !props.group.tabs.includes(name);
    // Splitting off a pane's only tab would leave nothing behind.
    return props.group.tabs.length > 1;
  };
  function zone(kind: SplitDirection | "move") {
    return {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        setOver(kind);
      },
      onDragLeave: () => setOver((current) => (current === kind ? null : current)),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        const name = e.dataTransfer?.getData(TAB_MIME) || draggingTab();
        setOver(null);
        setDraggingTab(null);
        if (!name) return;
        if (kind === "move") nav.moveWorkspaceTab(name, props.index, props.group.tabs.length);
        else nav.splitWorkspaceTab(name, kind);
      },
    };
  }
  return (
    <Show when={show()}>
      <div class="ws-pane-dropzones">
        <Show
          when={split()}
          fallback={
            <>
              <div class="ws-pane-dropzone ws-pane-dropzone-right" classList={{ "is-over": over() === "right" }} {...zone("right")}>
                <span>Split Right</span>
              </div>
              <div class="ws-pane-dropzone ws-pane-dropzone-down" classList={{ "is-over": over() === "down" }} {...zone("down")}>
                <span>Split Down</span>
              </div>
            </>
          }
        >
          <div class="ws-pane-dropzone ws-pane-dropzone-all" classList={{ "is-over": over() === "move" }} {...zone("move")}>
            <span>Move Here</span>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function WorkspacePane(props: { group: TabGroup; index: number }) {
  let root: HTMLDivElement | undefined;
  const focused = () => nav.workspaceTabs().focused === props.index;
  const split = () => nav.workspaceTabs().groups.length > 1;
  // Any click or keyboard focus inside a pane makes it the focused one, so the
  // sidebar highlight, shortcuts, and actions follow where the user is working.
  onMount(() => {
    const claim = () => {
      if (!focused()) nav.focusTabGroup(props.index);
    };
    root?.addEventListener("pointerdown", claim, true);
    root?.addEventListener("focusin", claim, true);
    onCleanup(() => {
      root?.removeEventListener("pointerdown", claim, true);
      root?.removeEventListener("focusin", claim, true);
    });
  });
  return (
    <div
      ref={root}
      class="ws-pane"
      classList={{ "ws-pane-focused": focused(), "ws-pane-split": split() }}
      data-pane-index={props.index}
    >
      <TabStrip group={props.group} index={props.index} focused={focused()} />
      <div class="ws-pane-body">
        <Show
          when={props.group.active}
          fallback={<div class="empty-state">Select a workspace from the sidebar.</div>}
        >
          {(workspace) => (
            <PaneProvider value={paneFor(workspace, focused)}>
              <CommandCenter workspace={workspace()} />
            </PaneProvider>
          )}
        </Show>
        <DropZones group={props.group} index={props.index} />
      </div>
    </div>
  );
}

export default function WorkspacePanes() {
  const tabs = nav.workspaceTabs;

  // Close tabs whose workspace was archived or deleted, or that the daemon no
  // longer knows. Tracks the inventory only: re-running on tab changes would
  // drop a just-created workspace's tab before its row arrives.
  createEffect(
    on(
      () => {
        if (!workspacesStore.loaded()) return null;
        return workspacesStore.state.order.map((name) => `${name}:${workspacesStore.row(name)?.status ?? ""}`).join("|");
      },
      (inventory) => {
        if (inventory == null) return;
        nav.retainWorkspaceTabs((name) => {
          const row = workspacesStore.row(name);
          return row != null && row.status !== "archived";
        });
      },
    ),
  );

  return (
    <div
      class="ws-panes"
      classList={{ "ws-panes-split": tabs().groups.length > 1, "ws-panes-down": tabs().direction === "down" }}
    >
      <Index each={tabs().groups}>{(group, index) => <WorkspacePane group={group()} index={index} />}</Index>
    </div>
  );
}
