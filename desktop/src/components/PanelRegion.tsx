import { For, Show, Suspense, createMemo } from "solid-js";
import { activatePanel, type PanelId, type Region } from "@/lib/layout";
import { panelDescriptor } from "@/lib/panelRegistry";
import { layoutStore } from "@/store/layout";
import { workspacesStore } from "@/store/workspaces";
import { ReviewPromptButton } from "@/pages/WorkspaceTabs";

function domId(region: Region, panel: PanelId, suffix: string) {
  return `workbench-${region}-${panel.replace(/[^a-zA-Z0-9_-]/g, "-")}-${suffix}`;
}

export default function PanelRegion(props: { workspace: string; region: Region }) {
  const stack = () => layoutStore.layout().regions[props.region];
  const activeId = () => stack().panels[stack().active];
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
  const showTabs = createMemo(() => stack().panels.length > 0);

  function activate(id: PanelId) {
    layoutStore.mutate((layout) => activatePanel(layout, id));
  }

  function focusTab(index: number) {
    const panels = stack().panels;
    const id = panels[Math.max(0, Math.min(index, panels.length - 1))];
    if (!id) return;
    activate(id);
    queueMicrotask(() => document.getElementById(domId(props.region, id, "tab"))?.focus());
  }

  function navigateTabs(event: KeyboardEvent, index: number) {
    const last = stack().panels.length - 1;
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    if (next === undefined) return;
    event.preventDefault();
    focusTab(next);
  }

  return (
    <section
      class={`workbench-region workbench-region-${props.region}`}
      classList={{
        "ws-right-panel": props.region === "right",
        "ws-center": props.region === "center",
        "ws-left-panel": props.region === "left",
        "ws-bottom-panel": props.region === "bottom",
      }}
      data-region={props.region}
      data-focus-target={props.region === "right" ? "workspace-panel" : undefined}
      tabIndex={-1}
      onFocusIn={() => layoutStore.setFocusedRegion(props.region)}
    >
      <For each={stack().strips}>
        {(id) => {
          const descriptor = panelDescriptor(id);
          if (!descriptor) return null;
          const Component = descriptor.component;
          return (
            <div
              class="workbench-strip ws-right-topbar"
              data-panel-id={id}
              data-panel-kind="strip"
              tabIndex={-1}
            >
              <Suspense><Component workspace={props.workspace} region={props.region} /></Suspense>
            </div>
          );
        }}
      </For>

      <Show when={showTabs()}>
        <div
          class="workbench-tablist command-center-strip ws-right-tabs"
          classList={{ "workbench-tablist-single": stack().panels.length === 1 }}
          role="tablist"
          aria-label={`${props.region} panels`}
        >
          <For each={stack().panels}>
            {(id, index) => {
              const descriptor = panelDescriptor(id);
              if (!descriptor) return null;
              const selected = () => activeId() === id;
              return (
                <button
                  id={domId(props.region, id, "tab")}
                  class="nav-button workbench-tab"
                  classList={{ "nav-button-active": selected() }}
                  role="tab"
                  aria-selected={selected()}
                  aria-controls={domId(props.region, id, "panel")}
                  tabIndex={selected() ? 0 : -1}
                  data-panel-id={id}
                  data-panel-kind="tab"
                  onClick={() => activate(id)}
                  onKeyDown={(event) => navigateTabs(event, index())}
                >
                  <span>{descriptor.title}</span>
                  <Show when={tabCount(id)}>
                    {(count) => <span class="nav-button-count">{count()}</span>}
                  </Show>
                </button>
              );
            }}
          </For>
          <Show when={stack().panels.includes("changes")}>
            <ReviewPromptButton workspace={props.workspace} />
          </Show>
        </div>

        <Show when={activeDescriptor()}>
          {(descriptor) => {
            const Component = descriptor().component;
            return (
              <div
                id={domId(props.region, descriptor().id, "panel")}
                class="workbench-panel-body"
                classList={{
                  "ws-right-body": props.region === "right",
                  "ws-center-content": props.region === "center",
                }}
                role="tabpanel"
                aria-labelledby={domId(props.region, descriptor().id, "tab")}
                data-panel-id={descriptor().id}
                data-panel-kind="tab"
              >
                <Suspense><Component workspace={props.workspace} region={props.region} /></Suspense>
              </div>
            );
          }}
        </Show>
      </Show>

      <For each={stack().docks}>
        {(id) => {
          const descriptor = panelDescriptor(id);
          if (!descriptor) return null;
          const Component = descriptor.component;
          return (
            <div class="workbench-dock" data-panel-id={id} data-panel-kind="dock" tabIndex={-1}>
              <Suspense><Component workspace={props.workspace} region={props.region} /></Suspense>
            </div>
          );
        }}
      </For>
    </section>
  );
}
