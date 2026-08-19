import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import Icon from "./Icon";
import { nextListIndex } from "@/lib/keyboardList";
import type { IconName } from "./Icon";

export interface CompactSelectOption {
  value: string;
  label: string;
  group?: string;
}

export default function CompactSelect(props: {
  value: string;
  options: CompactSelectOption[];
  onChange: (value: string) => void;
  title?: string;
  icon?: IconName;
  class?: string;
  /**
   * Which way the menu opens. Defaults to "up", which suits the composer
   * controls sitting at the bottom of the window; a trigger near the top of a
   * panel needs "down" or the menu is clipped off the top edge.
   */
  placement?: "up" | "down";
}) {
  const [open, setOpen] = createSignal(false);
  const [cursor, setCursor] = createSignal(0);
  // Anchor rect captured when the menu opens. The menu renders in a portal so
  // it can escape scrolling panels that would otherwise clip it, which means it
  // has to be positioned against the trigger explicitly.
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  let root: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;

  function toggle(next: boolean) {
    if (next && trigger) setAnchor(trigger.getBoundingClientRect());
    setOpen(next);
  }

  const menuStyle = () => {
    const rect = anchor();
    if (!rect) return {};
    const base = { position: "fixed" as const, "min-width": `${rect.width}px` };
    return props.placement === "down"
      ? {
          ...base,
          top: `${rect.bottom + 5}px`,
          left: "auto",
          right: `${Math.max(8, window.innerWidth - rect.right)}px`,
          bottom: "auto",
        }
      : {
          ...base,
          bottom: `${window.innerHeight - rect.top + 5}px`,
          left: `${rect.left}px`,
          right: "auto",
          top: "auto",
        };
  };
  const selected = () => props.options.find((o) => o.value === props.value) ?? props.options[0];
  const selectedIndex = () => Math.max(0, props.options.findIndex((o) => o.value === props.value));

  function selectAt(index: number) {
    const option = props.options[index];
    if (!option) return;
    props.onChange(option.value);
    setOpen(false);
  }

  function moveCursor(move: Parameters<typeof nextListIndex>[2]) {
    setCursor((current) => nextListIndex(current, props.options.length, move));
  }

  function onTriggerKeyDown(event: KeyboardEvent) {
    if (open()) {
      onMenuKeyDown(event);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setCursor(selectedIndex());
      toggle(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setCursor(selectedIndex());
      toggle(!open());
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveCursor("next");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveCursor("previous");
    } else if (event.key === "Home") {
      event.preventDefault();
      moveCursor("first");
    } else if (event.key === "End") {
      event.preventDefault();
      moveCursor("last");
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectAt(cursor());
    }
  }

  createEffect(() => {
    if (!open()) return;
    setCursor(selectedIndex());
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      // The menu is portalled to <body>, so it is not inside `root`; check it
      // separately or clicking the menu's own chrome would dismiss it.
      if (root?.contains(target) || menu?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div class={`compact-select ${props.class ?? ""}`} ref={root}>
      <button
        class="compact-select-trigger"
        ref={trigger}
        title={props.title}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => toggle(!open())}
        onKeyDown={onTriggerKeyDown}
      >
        <Show when={props.icon}>
          {(icon) => <Icon name={icon()} class="compact-select-icon" />}
        </Show>
        <span class="compact-select-label">{selected()?.label ?? props.value}</span>
        <Icon name="chevron-down" class="compact-select-caret" />
      </button>
      <Show when={open()}>
        {/* Portalled so a scrolling ancestor cannot clip the menu — the changes
            panel sets overflow-y, which used to cut the list off mid-way. */}
        <Portal>
          <div
            class="compact-select-menu compact-select-menu-floating"
            ref={menu}
            style={menuStyle()}
            role="listbox"
            tabIndex={-1}
            onKeyDown={onMenuKeyDown}
          >
            <For each={props.options}>
              {(option, i) => (
                <>
                  <Show when={option.group && props.options[i() - 1]?.group !== option.group}>
                    <div class="compact-select-group">{option.group}</div>
                  </Show>
                  <button
                    class="compact-select-option"
                    classList={{
                      "compact-select-option-active": option.value === props.value,
                      "compact-select-option-focused": i() === cursor(),
                      "compact-select-option-grouped": !!option.group,
                    }}
                    role="option"
                    aria-selected={option.value === props.value}
                    onClick={() => {
                      props.onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                </>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
