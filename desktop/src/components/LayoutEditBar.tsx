import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { PanelId } from "@/lib/layout";
import { hiddenPanelControls } from "@/lib/layoutControls";
import { layoutStore } from "@/store/layout";
import Icon from "./Icon";

/**
 * The chrome for the explicit layout-edit mode: visible only while
 * `layoutStore.editing()` is true. Edits made while this bar is up are live —
 * there is no undo stack. `Done` just leaves the mode; `Revert changes`
 * restores the single snapshot `layoutStore.setEditing(true)` took the moment
 * edit mode was entered (see `store/layout.ts`), so its label stays truthful
 * regardless of what the active preset gets renamed to mid-session.
 */
export default function LayoutEditBar() {
  const [addOpen, setAddOpen] = createSignal(false);
  const hidden = () => hiddenPanelControls(layoutStore.hiddenPanels());
  let menuEl: HTMLDivElement | undefined;
  let triggerEl: HTMLButtonElement | undefined;

  function addPanel(id: PanelId) {
    layoutStore.addPanel(id);
    closeAddMenu();
  }

  /**
   * Dismiss on a pointerdown outside both the menu and its trigger — never on
   * any pointerdown, which is what the previous `{ once: true }` listener did.
   * That fired on the *opening* pointerdown of a click on a menu item just as
   * readily as an outside one, unmounting the menu before the matching
   * pointerup/click could ever reach the item: selecting a panel by mouse
   * never worked. Checking containment (rather than switching to a "click"
   * listener) keeps the same immediate, click-away-to-dismiss feel the rest
   * of the app's menus use (see `LayoutControls`'s backdrop).
   */
  function onWindowPointerDown(event: PointerEvent) {
    const target = event.target;
    if (target instanceof Node && (menuEl?.contains(target) || triggerEl?.contains(target))) return;
    closeAddMenu();
  }

  function openAddMenu() {
    setAddOpen(true);
    window.addEventListener("pointerdown", onWindowPointerDown);
  }

  function closeAddMenu() {
    setAddOpen(false);
    window.removeEventListener("pointerdown", onWindowPointerDown);
  }

  function toggleAdd() {
    if (addOpen()) closeAddMenu();
    else openAddMenu();
  }
  onCleanup(() => window.removeEventListener("pointerdown", onWindowPointerDown));

  // This bar's own root <Show> unmounts the menu's markup the moment edit
  // mode exits (Escape, Done, or otherwise), but `addOpen` and the dismiss
  // listener are owned by this always-mounted component, not by that <Show>,
  // so without this they'd survive across sessions: leaving the menu open,
  // then leaving edit mode, then re-entering it would remount an "open" menu
  // with no dismiss listener attached to it at all.
  createEffect(() => {
    if (!layoutStore.editing()) closeAddMenu();
  });

  return (
    <Show when={layoutStore.editing()}>
      <div class="layout-edit-bar" role="toolbar" aria-label="Editing layout">
        <Icon name="layout-dashboard" />
        <span class="layout-edit-bar-label">Editing layout</span>
        <div class="layout-edit-bar-actions">
          <Show when={hidden().length > 0}>
            <div class="layout-edit-add">
              <button
                ref={triggerEl}
                class="layout-edit-btn"
                aria-haspopup="menu"
                aria-expanded={addOpen()}
                onClick={() => toggleAdd()}
              >
                <Icon name="plus" />
                <span>Add panel</span>
              </button>
              <Show when={addOpen()}>
                <div ref={menuEl} class="layout-edit-add-menu" role="menu">
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
          <button class="layout-edit-btn" onClick={() => layoutStore.revertEdits()}>
            <Icon name="refresh" />
            <span>Revert changes</span>
          </button>
          <button class="layout-edit-btn layout-edit-done" onClick={() => layoutStore.setEditing(false)}>
            Done
          </button>
        </div>
      </div>
    </Show>
  );
}
