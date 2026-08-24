import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { Region } from "@/lib/layout";
import { hiddenPanelControls } from "@/lib/layoutControls";
import { layoutStore } from "@/store/layout";
import { actions } from "@/store/actions";
import Icon from "./Icon";

const [layoutMessage, setLayoutMessage] = createSignal("");
const REGIONS: Region[] = ["left", "right", "bottom"];

export function announceLayout(message: string) {
  setLayoutMessage("");
  queueMicrotask(() => setLayoutMessage(message));
}

export default function LayoutControls(_props: { workspace: string }) {
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  const hidden = () => hiddenPanelControls(layoutStore.hiddenPanels());
  const hasContent = (region: Region) => {
    const stack = layoutStore.layout().regions[region];
    return stack.panels.length + stack.strips.length + stack.docks.length > 0;
  };

  function close(returnFocus = false) {
    setOpen(false);
    if (returnFocus) queueMicrotask(() => trigger?.focus());
  }

  function restore(id: string, title: string) {
    actions.revealPanel(id);
    announceLayout(`${title} restored.`);
    close(true);
  }

  function toggleRegion(region: Region) {
    const collapsed = layoutStore.layout().regions[region].collapsed;
    layoutStore.collapseRegion(region, !collapsed);
    announceLayout(`${region[0].toUpperCase()}${region.slice(1)} region ${collapsed ? "shown" : "collapsed"}.`);
    close(true);
  }

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open()) {
        event.preventDefault();
        close(true);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="layout-controls">
      <button
        ref={trigger}
        class="layout-trigger ws-topbar-btn"
        aria-label="Layout"
        aria-haspopup="menu"
        aria-expanded={open()}
        title={`Layout: ${layoutStore.activePreset().name}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="layout-dashboard" />
        <span>{layoutStore.activePreset().name}</span>
        <Icon name="chevron-down" class="layout-trigger-chevron" />
      </button>
      <Show when={open()}>
        <div class="layout-menu-backdrop" onPointerDown={() => close(false)}>
          <div class="layout-menu" role="menu" aria-label="Workspace layout" onPointerDown={(event) => event.stopPropagation()}>
            <div class="layout-menu-heading">{layoutStore.activePreset().name}</div>
            <Show when={hidden().length > 0}>
              <div class="layout-menu-section-label">Hidden panels</div>
              <For each={hidden()}>
                {(panel) => (
                  <button
                    class="layout-menu-item"
                    role="menuitem"
                    aria-label={panel.ariaLabel}
                    onClick={() => restore(panel.id, panel.title)}
                  >
                    <Icon name={panel.icon} />
                    <span>Show {panel.title}</span>
                  </button>
                )}
              </For>
            </Show>
            <div class="layout-menu-section-label">Regions</div>
            <For each={REGIONS.filter(hasContent)}>
              {(region) => {
                const collapsed = () => layoutStore.layout().regions[region].collapsed;
                const title = () => `${region[0].toUpperCase()}${region.slice(1)}`;
                return (
                  <button
                    class="layout-menu-item"
                    role="menuitem"
                    aria-label={`${collapsed() ? "Show" : "Collapse"} ${region} region`}
                    onClick={() => toggleRegion(region)}
                  >
                    <Icon name={region === "right" ? "panel-right" : region === "left" ? "panel-left" : "square"} />
                    <span>{collapsed() ? "Show" : "Collapse"} {title()}</span>
                  </button>
                );
              }}
            </For>
            <div class="layout-menu-separator" />
            <button
              class="layout-menu-item"
              role="menuitem"
              onClick={() => {
                layoutStore.resetToCode();
                announceLayout("Layout reset to Code.");
                close(true);
              }}
            >
              <Icon name="refresh" />
              <span>Reset to Code</span>
            </button>
          </div>
        </div>
      </Show>
      <span class="sr-only" aria-live="polite" aria-atomic="true">{layoutMessage()}</span>
    </div>
  );
}
