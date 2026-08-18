import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import Icon, { type IconName } from "./Icon";

// Lightweight global right-click menu (parity with the GTK sidebar popovers).
// Any surface calls openContextMenu(event, items); a single <ContextMenu/> host
// mounted at the app root renders the active menu at the cursor.

export interface ContextMenuItem {
  label: string;
  icon?: IconName;
  iconSrc?: string;
  iconAlt?: string;
  destructive?: boolean;
  run: () => void;
}

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

const [menu, setMenu] = createSignal<MenuState | null>(null);

export function openContextMenu(e: MouseEvent, items: ContextMenuItem[]): void {
  e.preventDefault();
  e.stopPropagation();
  if (items.length === 0) return;
  setMenu({ x: e.clientX, y: e.clientY, items });
}

export function openContextMenuAt(x: number, y: number, items: ContextMenuItem[]): void {
  if (items.length === 0) return;
  setMenu({ x, y, items });
}

export default function ContextMenu() {
  const close = () => setMenu(null);
  // Clamped position, filled in once the menu is measured. Null until then so we
  // render at the raw cursor coords (no top-left flash) and refine after mount.
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  createEffect(on(menu, () => setPos(null)));

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    // Close if the window loses focus, resizes, or anything scrolls underneath —
    // otherwise the menu floats detached from the row it was opened on.
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    });
  });

  // Keep the menu fully on-screen: shift left/up when it would overflow the
  // right or bottom edge.
  const clamp = (el: HTMLDivElement) => {
    const m = menu();
    if (!m) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(m.x, window.innerWidth - rect.width - pad));
    const top = Math.max(pad, Math.min(m.y, window.innerHeight - rect.height - pad));
    setPos({ left, top });
  };

  return (
    <Show when={menu()}>
      {(m) => (
        <div
          class="context-menu-backdrop"
          onClick={close}
          onContextMenu={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <div
            class="context-menu"
            ref={(el) => queueMicrotask(() => clamp(el))}
            style={{ left: `${pos()?.left ?? m().x}px`, top: `${pos()?.top ?? m().y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <For each={m().items}>
              {(item) => (
                <button
                  class="context-menu-item"
                  classList={{ "context-menu-item-destructive": !!item.destructive }}
                  onClick={() => {
                    close();
                    item.run();
                  }}
                >
                  <Show when={item.iconSrc}>
                    {(src) => <img class="context-menu-item-logo" src={src()} alt={item.iconAlt ?? ""} aria-hidden={!item.iconAlt} />}
                  </Show>
                  <Show when={!item.iconSrc && item.icon}>
                    <Icon name={item.icon!} class="context-menu-item-icon" />
                  </Show>
                  <span class="context-menu-item-label">{item.label}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
}
