// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockApi {
  request: ReturnType<typeof vi.fn>;
  ensureEvents: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onWindowFocus: ReturnType<typeof vi.fn>;
  window: { minimize: () => void; toggleMaximize: () => void; close: () => void };
}

let api: MockApi;

beforeEach(() => {
  vi.resetModules();
  api = {
    request: vi.fn(async () => ({ type: "ack" })),
    ensureEvents: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn(() => () => {}),
    onWindowFocus: vi.fn(() => () => {}),
    window: { minimize: () => {}, toggleMaximize: () => {}, close: () => {} },
  };
  (globalThis as unknown as { window: { archductor: MockApi } }).window = { archductor: api };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("queueManagedChatInput", () => {
  it("starts the managed session before queueing input", async () => {
    const { queueManagedChatInput } = await import("./chatSend");

    await queueManagedChatInput({
      workspace: "vulkan",
      threadId: 7,
      input: "run smoke",
      visibleInput: "run visible smoke",
      kind: "user",
      sessionKind: "codex",
    });

    expect(api.request.mock.calls.map((call) => call[0])).toEqual([
      {
        type: "ensure_chat_thread_session",
        workspace: "vulkan",
        thread_id: 7,
        kind: "codex",
      },
      {
        type: "queue_chat_input",
        thread_id: 7,
        input: "run smoke",
        visible_input: "run visible smoke",
        kind: "user",
        session_kind: "codex",
      },
    ]);
  });
});
