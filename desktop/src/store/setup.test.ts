// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Covers the setup readiness store: probing sends get_setup_readiness, recheck
// asks archcar to refresh the environment first, and `blocked()` mirrors the
// backend `complete` flag.

interface MockApi {
  request: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

let api: MockApi;

function response(payload: unknown) {
  return payload as never;
}

function report(complete: boolean, extra: Record<string, unknown> = {}) {
  return {
    type: "setup_readiness",
    report: {
      rows: [],
      feedback: complete ? "Setup is complete." : "Install GitHub CLI.",
      complete,
      ...extra,
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  api = {
    request: vi.fn(async () => response(report(true))),
    onEvent: vi.fn(() => () => {}),
    log: vi.fn(),
  };
  (globalThis as unknown as { window: { archductor: MockApi } }).window = { archductor: api };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("setupStore", () => {
  it("probes without an environment refresh on check", async () => {
    api.request.mockResolvedValue(response(report(true)));
    const { setupStore } = await import("./setup");
    const result = await setupStore.check();

    expect(result.complete).toBe(true);
    expect(api.request).toHaveBeenCalledWith({ type: "get_setup_readiness", recheck: false });
    expect(setupStore.blocked()).toBe(false);
  });

  it("blocks while setup is incomplete", async () => {
    api.request.mockResolvedValue(response(report(false)));
    const { setupStore } = await import("./setup");
    await setupStore.check();

    expect(setupStore.blocked()).toBe(true);
    expect(setupStore.report()?.feedback).toBe("Install GitHub CLI.");
  });

  it("refreshes the environment on recheck", async () => {
    api.request.mockResolvedValue(response(report(true)));
    const { setupStore } = await import("./setup");
    await setupStore.recheck();

    expect(api.request).toHaveBeenCalledWith({ type: "get_setup_readiness", recheck: true });
  });

  it("throws when archcar returns an error response", async () => {
    api.request.mockResolvedValue(response({ type: "error", message: "probe failed" }));
    const { setupStore } = await import("./setup");

    await expect(setupStore.check()).rejects.toThrow("probe failed");
  });
});
