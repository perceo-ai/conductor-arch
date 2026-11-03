import { Show, createEffect, on, onCleanup, onMount } from "solid-js";
import { nav, workspacesStore, repositoriesStore } from "@/store";
import { layoutStore } from "@/store/layout";
import { layoutPresetsStore } from "@/store/layoutPresets";
import { toastsStore } from "@/store/toasts";
import { openExternal } from "@/bridge/client";
import { titleCaseWorkspace } from "@/lib/text";
import Icon from "@/components/Icon";
import { openContextMenuAt, type ContextMenuItem } from "@/components/ContextMenu";
import WorkspaceWorkbench from "@/components/WorkspaceWorkbench";
import LayoutControls from "@/components/LayoutControls";
import PanelDnd from "@/components/PanelDnd";
import { openWithItems, workspaceOpenRoot } from "@/lib/openWith";
import { configuredShortcut } from "@/lib/configuredShortcut";
import { usePane } from "./paneContext";

function TopBar(props: { workspace: string; compact?: boolean }) {
  const pane = usePane();
  let openButton: HTMLButtonElement | undefined;
  const row = () => workspacesStore.row(props.workspace);
  const rightCollapsed = () => layoutStore.sidePanelCollapsed();
  const workspaceRoot = () => {
    const repo = row()?.repository;
    return workspaceOpenRoot(row()?.path, repo ? repositoriesStore.row(repo)?.rootPath : undefined);
  };
  const openItems = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    const root = workspaceRoot();
    if (root) items.push(...openWithItems(root));
    const prUrl = row()?.prUrl;
    if (prUrl) items.push({ label: "Open pull request", icon: "external", run: () => void openExternal(prUrl) });
    return items;
  };
  function openMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenuAt(rect.left, rect.bottom + 4, openItems());
  }
  function toggleRight() {
    layoutStore.toggleSidePanel();
  }
  onMount(() => {
    const onOpen = () => {
      if (!pane.focused()) return;
      const rect = openButton?.getBoundingClientRect();
      if (rect) openContextMenuAt(rect.left, rect.bottom + 4, openItems());
    };
    window.addEventListener("archductor:open-workspace-menu", onOpen);
    onCleanup(() => window.removeEventListener("archductor:open-workspace-menu", onOpen));
  });
  return (
    <div class="ws-topbar">
      <div class="ws-topbar-breadcrumb">
        <span class="ws-topbar-repo">{titleCaseWorkspace(props.workspace)}</span>
        <span class="ws-topbar-sep">&gt;</span>
        <span class="ws-topbar-branch">{row()?.branch ?? "branch loading"}</span>
      </div>
      <div class="ws-topbar-actions">
        {/* Layout and right-panel controls drive the shared workbench, which a
            compact (unfocused) pane does not show — offering them here would
            visibly change the other pane. */}
        <Show when={!props.compact}>
          <LayoutControls workspace={props.workspace} />
        </Show>
        <button
          class="ws-open-menu-button ws-topbar-btn"
          aria-label="Open workspace"
          title="Open"
          data-shortcut={configuredShortcut("open-menu")}
          ref={openButton}
          onClick={openMenu}
        >
          <Icon name="external" />
          <Icon name="chevron-down" class="ws-open-menu-chevron" />
        </button>
        <Show when={!props.compact}>
          <button
            class="ui-button-icon ws-topbar-btn"
            aria-label={rightCollapsed() ? "Show right panel" : "Collapse right panel"}
            title={rightCollapsed() ? "Show right panel" : "Collapse right panel"}
            data-shortcut={configuredShortcut("toggle-right-panel")}
            onClick={toggleRight}
          >
            <Icon name={rightCollapsed() ? "panel-left" : "panel-right"} />
          </button>
        </Show>
      </div>
    </div>
  );
}

export default function CommandCenter(props: { workspace: string }) {
  const pane = usePane();
  // With the view split, the unfocused pane is a plain chat column: the
  // inspector, terminal, and the rest of the layout follow the focused pane,
  // so neither chat is squeezed by a second full workbench.
  const compact = () => nav.workspaceTabs().groups.length > 1 && !pane.focused();

  // Layout presets are per repository but the layout itself is shared, so only
  // the focused pane decides which repository's presets are loaded; two panes
  // from different repositories would otherwise reload them in turn.
  createEffect(
    on(
      () => (pane.focused() ? workspacesStore.row(props.workspace)?.repository : undefined),
      (repository) => {
        if (!repository) return;
        if (layoutPresetsStore.loaded() && layoutPresetsStore.lastRepository() === repository) return;
        void layoutPresetsStore
          .load(repository)
          .catch((error) => toastsStore.error(`Could not load layouts: ${(error as Error).message}`));
      },
    ),
  );
  onCleanup(() => layoutPresetsStore.cancelPendingSave());

  return (
    <div class="ws-command-center page-shell" data-focus-target="workspace-main" tabIndex={-1}>
      <PanelDnd>
        <WorkspaceWorkbench
          workspace={props.workspace}
          compact={compact()}
          topbar={<TopBar workspace={props.workspace} compact={compact()} />}
        />
      </PanelDnd>
    </div>
  );
}
