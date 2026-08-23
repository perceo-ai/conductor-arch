import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toastsStore } from "./toasts";

describe("toastsStore dismiss lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Flush first: a toast left mid-exit by the previous test is already
    // `leaving`, and dismiss() deliberately ignores those — only its pending
    // removal timer can clear it.
    vi.runAllTimers();
    for (const t of [...toastsStore.state.items]) toastsStore.dismiss(t.id);
    vi.runAllTimers();
  });

  afterEach(() => {
    // Drain before handing timers back: switching to real timers discards
    // pending fake ones, which would strand a mid-exit toast in the shared
    // module-level store for every later test.
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it("keeps a dismissed toast mounted so its exit animation can play", () => {
    const id = toastsStore.push("hello", "info", 0);
    toastsStore.dismiss(id);

    const leaving = toastsStore.state.items.find((t) => t.id === id);
    expect(leaving).toBeDefined();
    expect(leaving?.leaving).toBe(true);
  });

  it("removes the toast once the exit window elapses", () => {
    const id = toastsStore.push("hello", "info", 0);
    toastsStore.dismiss(id);
    vi.advanceTimersByTime(500);

    expect(toastsStore.state.items.find((t) => t.id === id)).toBeUndefined();
  });

  it("ignores a second dismiss, so auto-expire racing a click cannot restart the exit", () => {
    const id = toastsStore.push("hello", "info", 0);
    toastsStore.dismiss(id);
    vi.advanceTimersByTime(100);
    toastsStore.dismiss(id);
    // If the second call had re-armed the timer, the toast would outlive this.
    vi.advanceTimersByTime(100);

    expect(toastsStore.state.items.find((t) => t.id === id)).toBeUndefined();
  });

  it("auto-expires on its ttl without an explicit dismiss", () => {
    const id = toastsStore.push("hello", "info", 1000);
    vi.advanceTimersByTime(999);
    expect(toastsStore.state.items.find((t) => t.id === id)?.leaving).toBeFalsy();

    vi.advanceTimersByTime(2);
    expect(toastsStore.state.items.find((t) => t.id === id)?.leaving).toBe(true);

    vi.advanceTimersByTime(500);
    expect(toastsStore.state.items.find((t) => t.id === id)).toBeUndefined();
  });

  it("dismisses only the named toast", () => {
    const a = toastsStore.push("a", "info", 0);
    const b = toastsStore.push("b", "info", 0);
    toastsStore.dismiss(a);
    vi.advanceTimersByTime(500);

    expect(toastsStore.state.items.map((t) => t.id)).toEqual([b]);
  });
});
