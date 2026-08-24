import { createSignal,  Show } from "solid-js";
import {
  type ConfirmSpec
} from "@/store";

// Global modal host. Renders the form for the active dialog spec. Every form
// calls into `actions.*`, which logs the action, sends the archcar request, and
// re-pulls the inventory on success.

// Generic confirm dialog, optionally with a single text input.
export function ConfirmForm(props: { spec: ConfirmSpec; onDone: () => void }) {
  const [value, setValue] = createSignal(props.spec.input?.initialValue ?? "");
  const ok = () => !props.spec.input || value().trim().length > 0;
  const run = () => {
    if (!ok()) return;
    props.spec.onConfirm(props.spec.input ? value().trim() : undefined);
    props.onDone();
  };
  return (
    <div class="dialog-form">
      <div class="dialog-message">{props.spec.message}</div>
      <Show when={props.spec.input}>
        {(inp) => (
          <label class="dialog-field">
            <span>{inp().label}</span>
            <input
              value={value()}
              ref={(el) => setTimeout(() => el.focus(), 0)}
              onInput={(e) => setValue(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
            />
          </label>
        )}
      </Show>
      <div class="dialog-actions">
        <button class="ui-button" onClick={props.onDone}>
          Cancel
        </button>
        <button
          class={props.spec.destructive ? "ui-button-destructive" : "ui-button"}
          disabled={!ok()}
          onClick={run}
        >
          {props.spec.confirmLabel}
        </button>
      </div>
    </div>
  );
}
