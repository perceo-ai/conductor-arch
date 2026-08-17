import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import Icon from "./Icon";

export interface CompactSelectOption {
  value: string;
  label: string;
}

export default function CompactSelect(props: {
  value: string;
  options: CompactSelectOption[];
  onChange: (value: string) => void;
  title?: string;
  class?: string;
}) {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  const selected = () => props.options.find((o) => o.value === props.value) ?? props.options[0];

  createEffect(() => {
    if (!open()) return;
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
      >
        <span class="compact-select-label">{selected()?.label ?? props.value}</span>
        <Icon name="chevron-down" class="compact-select-caret" />
      </button>
      <Show when={open()}>
        <div class="compact-select-menu" role="listbox">
          <For each={props.options}>
            {(option) => (
              <button
                class="compact-select-option"
                classList={{ "compact-select-option-active": option.value === props.value }}
                role="option"
                aria-selected={option.value === props.value}
                onClick={() => {
                  props.onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
