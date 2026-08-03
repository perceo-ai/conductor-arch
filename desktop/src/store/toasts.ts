import { createStore } from "solid-js/store";

// Transient, app-level notifications (errors + info) shown in a corner stack.
// Kept tiny on purpose — no queueing/positioning config, just push + auto-expire.

export interface Toast {
  id: number;
  kind: "error" | "info";
  message: string;
}

let seq = 1;
const [state, setState] = createStore<{ items: Toast[] }>({ items: [] });

export const toastsStore = {
  state,

  push(message: string, kind: Toast["kind"] = "info", ttlMs = 6000): number {
    const id = seq++;
    setState("items", (items) => [...items, { id, kind, message }]);
    if (ttlMs > 0) setTimeout(() => toastsStore.dismiss(id), ttlMs);
    return id;
  },

  error(message: string, ttlMs = 8000): number {
    return this.push(message, "error", ttlMs);
  },

  dismiss(id: number): void {
    setState("items", (items) => items.filter((t) => t.id !== id));
  },
};
