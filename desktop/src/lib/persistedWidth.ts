import { createSignal } from "solid-js";

// A width signal backed by localStorage. Used by the resizable sidebars so a
// dragged width survives reloads. Clamps the stored value to [min, max] on read
// so a stale/out-of-range entry can't wedge a panel off-screen.
export function createPersistedWidth(key: string, fallback: number, min: number, max: number) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  let initial = fallback;
  try {
    const stored = Number(localStorage.getItem(key));
    if (Number.isFinite(stored) && stored > 0) initial = clamp(stored);
  } catch {
    // localStorage unavailable — fall back to the default width.
  }
  const [width, setWidth] = createSignal(initial);
  const set = (v: number) => {
    const next = clamp(v);
    setWidth(next);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      // Ignore write failures; the in-memory width still applies this session.
    }
  };
  return [width, set] as const;
}
