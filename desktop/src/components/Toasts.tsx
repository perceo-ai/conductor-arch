import { For } from "solid-js";
import { toastsStore } from "@/store";

// App-level toast stack (bottom-right). Driven by toastsStore.
export default function Toasts() {
  return (
    <div class="toast-stack">
      <For each={toastsStore.state.items}>
        {(t) => (
          <div class="toast-item" classList={{ "toast-item-error": t.kind === "error" }}>
            <span class="toast-item-message">{t.message}</span>
            <button
              class="toast-item-close"
              title="Dismiss"
              onClick={() => toastsStore.dismiss(t.id)}
            >
              ✕
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
