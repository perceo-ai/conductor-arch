import { Show, onCleanup, onMount } from "solid-js";
import { nav, workspacesStore, repositoriesStore } from "@/store";
import { layoutStore } from "@/store/layout";
import { collapseRegion } from "@/lib/layout";
import { openExternal, openWorkspaceApp } from "@/bridge/client";
import { titleCaseWorkspace } from "@/lib/text";
import { runShellAction } from "@/lib/shellAction";
import Icon from "@/components/Icon";
import { openContextMenuAt, type ContextMenuItem } from "@/components/ContextMenu";
import WorkspaceWorkbench from "@/components/WorkspaceWorkbench";
import { WORKSPACE_OPEN_APPS, workspaceDefaultOpener } from "@/lib/workspaceOpenApps";

function TopBar(props: { workspace: string }) {
  let openButton: HTMLButtonElement | undefined;
  const row = () => workspacesStore.row(props.workspace);
  const rightCollapsed = () => layoutStore.layout().regions.right.collapsed;
  const repoRoot = () => {
    const repo = row()?.repository;
    return repo ? repositoriesStore.row(repo)?.rootPath : undefined;
  };
  const openItems = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    const root = repoRoot();
    if (root) {
      const defaultOpener = workspaceDefaultOpener();
      items.push({
        label: `Open in ${defaultOpener.label}`,
        iconSrc: defaultOpener.logoSrc,
        iconAlt: defaultOpener.label,
        run: () => runShellAction(`Open in ${defaultOpener.label}`, openExternal(root)),
      });
      for (const app of WORKSPACE_OPEN_APPS) {
        items.push({
          label: `Open in ${app.label}`,
          iconSrc: app.logoSrc,
          iconAlt: app.label,
          run: () => runShellAction(`Open in ${app.label}`, openWorkspaceApp({ rootPath: root, appId: app.id })),
        });
      }
    }
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
    layoutStore.mutate((layout) => collapseRegion(layout, "right", !rightCollapsed()));
  }
  onMount(() => {
    const onOpen = () => {
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
        <button class="ws-open-menu-button ws-topbar-btn" aria-label="Open workspace" title="Open" ref={openButton} onClick={openMenu}>
          <Icon name="external" />
          <Icon name="chevron-down" class="ws-open-menu-chevron" />
        </button>
        <button
          class="ui-button-icon ws-topbar-btn"
          aria-label={rightCollapsed() ? "Show right panel" : "Collapse right panel"}
          title={rightCollapsed() ? "Show right panel" : "Collapse right panel"}
          onClick={toggleRight}
        >
          <Icon name={rightCollapsed() ? "panel-left" : "panel-right"} />
        </button>
      </div>
    </div>
  );
}

export default function CommandCenter() {
  const workspace = () => nav.selectedWorkspace() ?? "";

  return (
    <Show when={workspace()} fallback={<div class="empty-state">Select a workspace from the sidebar.</div>}>
      {(ws) => (
        <div class="ws-command-center page-shell" data-focus-target="workspace-main" tabIndex={-1}>
          <WorkspaceWorkbench workspace={ws()} topbar={<TopBar workspace={ws()} />} />
        </div>
      )}
    </Show>
  );
}
