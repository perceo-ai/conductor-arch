// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Covers the startup flow introduced in App.onMount → startStore():
// serialize concurrent init, reset on failure so a later call retries, and the
// connectEvents listener cleanup on ensureEvents rejection. These are the
// behaviors flagged in review; they're testable at the store/bridge layer
// without rendering the Solid component (no jsdom needed — we stub the preload
// bridge that the renderer would normally receive from Electron).

interface MockApi {
  request: ReturnType<typeof vi.fn>;
  ensureEvents: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onWindowFocus: ReturnType<typeof vi.fn>;
  window: { minimize: () => void; toggleMaximize: () => void; close: () => void };
}

let offEvent: ReturnType<typeof vi.fn>;
let api: MockApi;

beforeEach(() => {
  vi.resetModules();
  offEvent = vi.fn();
  api = {
    request: vi.fn(async () => ({ type: "workspaces", workspaces: [] })),
    ensureEvents: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn(() => offEvent),
    onWindowFocus: vi.fn(() => () => {}),
    window: { minimize: () => {}, toggleMaximize: () => {}, close: () => {} },
  };
  (globalThis as unknown as { window: { archductor: MockApi } }).window = { archductor: api };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("startStore", () => {
  it("shares one in-flight init across concurrent callers", async () => {
    const { startStore } = await import("./index");
    const a = startStore();
    const b = startStore();
    expect(a).toBe(b);
    await a;
    // ensureEvents (the subscribe handshake) ran exactly once for both callers.
    expect(api.ensureEvents).toHaveBeenCalledTimes(1);
  });

  it("resets after a failed init so a later call retries", async () => {
    api.ensureEvents.mockRejectedValueOnce(new Error("daemon down"));
    const { startStore } = await import("./index");

    await expect(startStore()).rejects.toThrow("daemon down");
    // Failure must not leak the event listener registered in connectEvents.
    expect(offEvent).toHaveBeenCalledTimes(1);

    // A subsequent call re-attempts (memo was cleared) and now succeeds.
    await expect(startStore()).resolves.toBeUndefined();
    expect(api.ensureEvents).toHaveBeenCalledTimes(2);
  });
});
