import { For, Show, createSignal, onCleanup } from "solid-js";
import type { PanelId } from "@/lib/layout";
import { hiddenPanelControls } from "@/lib/layoutControls";
import { layoutStore } from "@/store/layout";
import Icon from "./Icon";

/**
 * The chrome for the explicit layout-edit mode: visible only while
 * `layoutStore.editing()` is true. Edits made while this bar is up are live —
 * there is no snapshot/restore buffer. `Done` just leaves the mode; the way
 * back to a known-good layout is `Reset to <preset>`, which re-applies the
 * active preset the same way choosing it from `LayoutControls` does.
 */
export default function LayoutEditBar() {
  const [addOpen, setAddOpen] = createSignal(false);
  const hidden = () => hiddenPanelControls(layoutStore.hiddenPanels());

  function addPanel(id: PanelId) {
    layoutStore.addPanel(id);
    setAddOpen(false);
  }

  function closeOnOutsideClick(event: PointerEvent) {
    if (!(event.target instanceof Node)) return;
    setAddOpen(false);
  }

  function toggleAdd() {
    const next = !addOpen();
    setAddOpen(next);
    if (next) queueMicrotask(() => window.addEventListener("pointerdown", closeOnOutsideClick, { once: true }));
  }
  onCleanup(() => window.removeEventListener("pointerdown", closeOnOutsideClick));

  return (
    <Show when={layoutStore.editing()}>
      <div class="layout-edit-bar" role="toolbar" aria-label="Editing layout">
        <Icon name="layout-dashboard" />
        <span class="layout-edit-bar-label">Editing layout</span>
        <div class="layout-edit-bar-actions">
          <Show when={hidden().length > 0}>
            <div class="layout-edit-add">
              <button
                class="layout-edit-btn"
                aria-haspopup="menu"
                aria-expanded={addOpen()}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleAdd();
                }}
              >
                <Icon name="plus" />
                <span>Add panel</span>
              </button>
              <Show when={addOpen()}>
                <div class="layout-edit-add-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                  <For each={hidden()}>
                    {(panel) => (
                      <button
                        class="layout-edit-add-item"
                        role="menuitem"
                        onClick={() => addPanel(panel.id)}
                      >
                        <Icon name={panel.icon} />
                        <span>{panel.title}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
          <button
            class="layout-edit-btn"
            onClick={() => layoutStore.applyLayout(layoutStore.activePreset())}
          >
            <Icon name="refresh" />
            <span>Reset to {layoutStore.activePreset().name}</span>
          </button>
          <button class="layout-edit-btn layout-edit-done" onClick={() => layoutStore.setEditing(false)}>
            Done
          </button>
        </div>
      </div>
    </Show>
  );
}
