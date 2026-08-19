// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockApi {
  request: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

let api: MockApi;

beforeEach(() => {
  vi.resetModules();
  api = {
    request: vi.fn(async (req: { type: string; thread_id?: number }) => {
      if (req.type === "get_chat_snapshot") {
        return {
          type: "chat_snapshot",
          snapshot: {
            thread_id: req.thread_id,
            messages: [],
            events: [],
            provider_events: [],
            queued_inputs: [],
            live_session: undefined,
          },
        };
      }
      if (req.type === "get_chat_projection") {
        return { type: "chat_projection", thread_id: req.thread_id, items: [] };
      }
      if (req.type === "list_workspaces") return { type: "workspaces", workspaces: [] };
      return { type: "ack" };
    }),
    log: vi.fn(),
  };
  (globalThis as unknown as { window: { archductor: MockApi } }).window = { archductor: api };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("loadThread", () => {
  it("pulls a pending ask and plan state that arrived before this window opened", async () => {
    api.request.mockImplementation(async (req: { type: string; thread_id?: number }) => {
      if (req.type === "get_chat_snapshot") {
        return {
          type: "chat_snapshot",
          snapshot: {
            thread_id: req.thread_id,
            messages: [],
            events: [],
            provider_events: [],
            queued_inputs: [],
          },
        };
      }
      if (req.type === "get_chat_projection") {
        return { type: "chat_projection", thread_id: req.thread_id, items: [] };
      }
      if (req.type === "list_provider_interactions") {
        return {
          type: "provider_interactions",
          interactions: [
            {
              id: "ask-1",
              provider_key: "claude",
              workspace: "berlin",
              thread_id: 9,
              session_id: 3,
              kind: "plan_approval",
              title: "Plan ready for review",
              detail: "# Plan",
              questions: [],
              status: "pending",
            },
          ],
        };
      }
      if (req.type === "get_chat_plan") {
        return {
          type: "chat_plan",
          thread_id: req.thread_id,
          plan_mode: true,
          plan_path: ".context/plans/thread-9-abc.md",
        };
      }
      return { type: "ack" };
    });

    const { loadThread } = await import("./reducer");
    const { interactionsStore } = await import("./interactions");
    const { chatStore } = await import("./chat");

    loadThread(9);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // An unanswered ask with no event left to replay is a hung agent the user
    // cannot see.
    expect(interactionsStore.pending(9)?.id).toBe("ask-1");
    expect(chatStore.slice(9).planMode).toBe(true);
    expect(chatStore.slice(9).planPath).toBe(".context/plans/thread-9-abc.md");
  });
});

describe("applyEvent plan mode", () => {
  it("tracks plan mode and the plan file for the chat", async () => {
    const { applyEvent } = await import("./reducer");
    const { chatStore } = await import("./chat");

    applyEvent({ type: "chat_plan_updated", thread_id: 4, plan_mode: true });
    expect(chatStore.slice(4).planMode).toBe(true);
    expect(chatStore.slice(4).planPath).toBeNull();

    // Approving a plan leaves plan mode but keeps the plan it will build from.
    applyEvent({
      type: "chat_plan_updated",
      thread_id: 4,
      plan_mode: false,
      plan_path: ".context/plans/thread-4-abc.md",
    });
    expect(chatStore.slice(4).planMode).toBe(false);
    expect(chatStore.slice(4).planPath).toBe(".context/plans/thread-4-abc.md");
  });
});

describe("applyEvent session failures", () => {
  it("surfaces a session error on its chat and clears it when the session comes back", async () => {
    const { applyEvent } = await import("./reducer");
    const { chatStore } = await import("./chat");

    applyEvent({
      type: "session_error",
      session_id: 5,
      thread_id: 3,
      message: "codex exited before it was ready",
    });
    expect(chatStore.slice(3).phase).toEqual({
      kind: "failed",
      message: "codex exited before it was ready",
    });

    applyEvent({ type: "session_ready", session_id: 6, thread_id: 3 });
    expect(chatStore.slice(3).phase).toEqual({ kind: "ready" });
    expect(chatStore.slice(3).session?.ready).toBe(true);
  });
});

describe("applyEvent chat attention", () => {
  it("marks a completed turn as attention only when its chat is not selected", async () => {
    const { applyEvent } = await import("./reducer");
    const { chatStore } = await import("./chat");
    const { nav } = await import("./nav");

    nav.selectChatThread(1);
    applyEvent({ type: "turn_completed", session_id: 11, thread_id: 2, status: "success" });
    expect(chatStore.slice(2).completedTurnAttention).toBe(true);

    applyEvent({ type: "turn_completed", session_id: 12, thread_id: 1, status: "success" });
    expect(chatStore.slice(1).completedTurnAttention).toBe(false);
  });
});
