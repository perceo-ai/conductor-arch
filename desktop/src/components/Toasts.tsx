import { For, Show } from "solid-js";
import { toastsStore } from "@/store";

// App-level toast stack (bottom-right). Driven by toastsStore.
export default function Toasts() {
  return (
    <div class="toast-stack">
      <For each={toastsStore.state.items}>
        {(t) => (
          <div class="toast-item" classList={{ "toast-item-error": t.kind === "error" }}>
            <span class="toast-item-message">{t.message}</span>
            <Show when={t.action}>
              {(action) => (
                <button
                  class="toast-item-action"
                  onClick={() => {
                    action().run();
                    toastsStore.dismiss(t.id);
                  }}
                >
                  {action().label}
                </button>
              )}
            </Show>
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
