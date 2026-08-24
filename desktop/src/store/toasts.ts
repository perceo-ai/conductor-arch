import { createStore } from "solid-js/store";

// Transient, app-level notifications (errors + info) shown in a corner stack.
// Kept tiny on purpose — no queueing/positioning config, just push + auto-expire.

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: "error" | "info";
  message: string;
  action?: ToastAction;
  /** Dismissed, but still mounted so its exit animation can play. Nothing else
   *  should treat a leaving toast as live — see `dismiss`. */
  leaving?: boolean;
}

/** Kept in step with the exit animation in motion/04-surfaces.css
 *  (`.toast-item-leaving` uses --mo-fast). Erring long only delays removal of
 *  an already-invisible element; erring short truncates the animation. */
const TOAST_EXIT_MS = 160;

let seq = 1;
const [state, setState] = createStore<{ items: Toast[] }>({ items: [] });

export const toastsStore = {
  state,

  push(message: string, kind: Toast["kind"] = "info", ttlMs = 6000, action?: ToastAction): number {
    const id = seq++;
    setState("items", (items) => [...items, { id, kind, message, action }]);
    if (ttlMs > 0) setTimeout(() => toastsStore.dismiss(id), ttlMs);
    return id;
  },

  error(message: string, ttlMs = 8000): number {
    return this.push(message, "error", ttlMs);
  },

  /** Two-step so the toast can animate out: mark it leaving, then unmount.
   *  Guarded against a second call (auto-expire racing a click on Dismiss),
   *  which would otherwise queue a duplicate removal and restart the exit. */
  dismiss(id: number): void {
    const toast = state.items.find((t) => t.id === id);
    if (!toast || toast.leaving) return;
    setState("items", (items) => items.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => {
      setState("items", (items) => items.filter((t) => t.id !== id));
    }, TOAST_EXIT_MS);
  },
};
