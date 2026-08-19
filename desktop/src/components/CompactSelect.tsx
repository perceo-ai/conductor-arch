import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
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
}) {
  const [open, setOpen] = createSignal(false);
  const [cursor, setCursor] = createSignal(0);
  let root: HTMLDivElement | undefined;
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
      setOpen(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setCursor(selectedIndex());
      setOpen((v) => !v);
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
      if (!root?.contains(event.target as Node)) setOpen(false);
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
        title={props.title}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        <Show when={props.icon}>
          {(icon) => <Icon name={icon()} class="compact-select-icon" />}
        </Show>
        <span class="compact-select-label">{selected()?.label ?? props.value}</span>
        <Icon name="chevron-down" class="compact-select-caret" />
      </button>
      <Show when={open()}>
        <div class="compact-select-menu" role="listbox" tabIndex={-1} onKeyDown={onMenuKeyDown}>
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
      </Show>
    </div>
  );
}
