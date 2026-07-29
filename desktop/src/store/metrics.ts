import { createSignal } from "solid-js";

// Dev-only update counter — port of crates/gtk-app/src/refresh.rs::RefreshMetrics.
// Every targeted store mutation records against a key so we can prove in dev that
// an event touched ONLY the slice it should have. Toggle with the env flag.

const enabled = import.meta.env.DEV || import.meta.env.VITE_UPDATE_METRICS === "1";

const counts = new Map<string, number>();
const [version, bump] = createSignal(0);

export function recordUpdate(key: string) {
  if (!enabled) return;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  bump(version() + 1);
}

export function updateMetrics() {
  version(); // subscribe
  return Object.fromEntries(counts);
}

export const metricsEnabled = enabled;
