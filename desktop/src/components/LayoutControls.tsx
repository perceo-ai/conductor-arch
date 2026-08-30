import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { hiddenPanelControls, layoutPresetControls } from "@/lib/layoutControls";
import { layoutStore } from "@/store/layout";
import { layoutPresetsStore } from "@/store/layoutPresets";
import { actions } from "@/store/actions";
import { dialogs } from "@/store/dialogs";
import { workspacesStore } from "@/store/workspaces";
import Icon from "./Icon";

const [layoutMessage, setLayoutMessage] = createSignal("");

export function announceLayout(message: string) {
  setLayoutMessage("");
  queueMicrotask(() => setLayoutMessage(message));
}

export default function LayoutControls(props: { workspace: string }) {
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const hidden = () => hiddenPanelControls(layoutStore.hiddenPanels());
  const presetControls = () =>
    layoutPresetControls(
      layoutPresetsStore.presets(),
      layoutStore.activePreset().id,
      layoutPresetsStore.projectDefaultId(),
    );
  const repository = () => workspacesStore.row(props.workspace)?.repository;

  function close(returnFocus = false) {
    setOpen(false);
    if (returnFocus) queueMicrotask(() => trigger?.focus());
  }

  function openMenu() {
    const next = !open();
    setOpen(next);
    if (next) queueMicrotask(() => menu?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus());
  }

  function choosePreset(id: string) {
    if (!layoutPresetsStore.select(id)) return;
    announceLayout(`${layoutStore.activePreset().name} layout selected.`);
    close(true);
  }

  function saveAsNew() {
    const current = layoutStore.activePreset();
    close(true);
    dialogs.open({
      kind: "confirm",
      title: "Save layout as new",
      message: "Name this layout so it can be used from any client.",
      confirmLabel: "Save layout",
      input: { label: "Layout name", initialValue: `${current.name} copy` },
      onConfirm: (name) => {
        if (!name?.trim()) return;
        void layoutPresetsStore.saveWorkingCopy(name).then((saved) => {
          if (saved) announceLayout(`${name.trim()} layout saved.`);
        });
      },
    });
  }

  function renameCurrent() {
    const current = layoutStore.activePreset();
    if (current.builtin) return;
    close(true);
    dialogs.open({
      kind: "confirm",
      title: `Rename ${current.name}`,
      message: "Choose a new name for this saved layout.",
      confirmLabel: "Rename",
      input: { label: "Layout name", initialValue: current.name },
      onConfirm: (name) => {
        if (!name?.trim()) return;
        void layoutPresetsStore.rename(name).then((renamed) => {
          if (renamed) announceLayout(`${name.trim()} layout renamed.`);
        });
      },
    });
  }

  function deleteCurrent() {
    const current = layoutStore.activePreset();
    if (current.builtin) return;
    close(true);
    dialogs.open({
      kind: "confirm",
      title: `Delete ${current.name}`,
      message: `Delete the saved layout “${current.name}”? This removes it for every client.`,
      confirmLabel: "Delete layout",
      destructive: true,
      onConfirm: () => {
        void layoutPresetsStore.delete(current.id).then((deleted) => {
          if (deleted) announceLayout(`${current.name} layout deleted.`);
        });
      },
    });
  }

  function setProjectDefault() {
    const project = repository();
    if (!project) return;
    const current = layoutStore.activePreset();
    close(true);
    void layoutPresetsStore.setProjectDefault(project, current.id).then((saved) => {
      if (saved) announceLayout(`${current.name} is now the ${project} project default.`);
    });
  }

  function navigateMenu(event: KeyboardEvent) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const index = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[index].focus();
  }

  function restore(id: string, title: string) {
    actions.revealPanel(id);
    announceLayout(`${title} restored.`);
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
        onClick={openMenu}
      >
        <Icon name="layout-dashboard" />
        <span>{layoutStore.activePreset().name}</span>
        <Icon name="chevron-down" class="layout-trigger-chevron" />
      </button>
      <Show when={open()}>
        <div class="layout-menu-backdrop" onPointerDown={() => close(false)}>
          <div
            ref={menu}
            class="layout-menu"
            role="menu"
            aria-label="Workspace layout"
            onKeyDown={navigateMenu}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div class="layout-menu-heading">{layoutStore.activePreset().name}</div>
            <button
              class="layout-menu-item"
              role="menuitem"
              onClick={() => {
                layoutStore.setEditing(true);
                close(true);
              }}
            >
              <Icon name="wrench" />
              <span>Edit layout</span>
            </button>
            <div class="layout-menu-separator" />
            <div class="layout-menu-section-label">Presets</div>
            <For each={presetControls()}>
              {(preset) => (
                <button
                  class="layout-menu-item layout-preset-item"
                  classList={{ "is-active": preset.active }}
                  role="menuitem"
                  aria-current={preset.active ? "true" : undefined}
                  aria-label={preset.label}
                  title={preset.locked ? "Built-in layouts are locked; editing creates a copy." : preset.label}
                  onClick={() => choosePreset(preset.id)}
                >
                  <span class="layout-preset-check">{preset.active ? "✓" : ""}</span>
                  <span>{layoutPresetsStore.presets().find((item) => item.id === preset.id)?.name}</span>
                  <Show when={preset.locked}><span class="layout-preset-badge">Built-in</span></Show>
                  <Show when={preset.id === layoutPresetsStore.projectDefaultId()}>
                    <span class="layout-preset-badge">Default</span>
                  </Show>
                </button>
              )}
            </For>
            <button class="layout-menu-item" role="menuitem" onClick={saveAsNew}>
              <Icon name="plus" />
              <span>Save as new…</span>
            </button>
            <Show when={!layoutStore.activePreset().builtin}>
              <button class="layout-menu-item" role="menuitem" onClick={renameCurrent}>
                <Icon name="pencil" />
                <span>Rename…</span>
              </button>
              <button class="layout-menu-item is-destructive" role="menuitem" onClick={deleteCurrent}>
                <Icon name="x" />
                <span>Delete…</span>
              </button>
            </Show>
            <Show when={repository()}>
              <button class="layout-menu-item" role="menuitem" onClick={setProjectDefault}>
                <Icon name="circle-check" />
                <span>Set as project default</span>
              </button>
            </Show>
            <div class="layout-menu-separator" />
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
            <div class="layout-menu-separator" />
            <button
              class="layout-menu-item"
              role="menuitem"
              onClick={() => {
                layoutPresetsStore.select("code");
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
