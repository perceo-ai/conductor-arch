// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockApi {
  request: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
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
    notify: vi.fn(async () => ({ ok: true })),
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
  it("flags a finished turn whichever chat is selected; seeing it is what clears the flag", async () => {
    const { applyEvent } = await import("./reducer");
    const { chatStore } = await import("./chat");
    const { nav } = await import("./nav");
    const live = { session_id: 11, status: "running", runtime_state: "streaming", ready: false };

    nav.selectChatThread(1);
    chatStore.setSession(1, live);
    chatStore.setSession(2, live);
    applyEvent({ type: "turn_completed", session_id: 11, thread_id: 2, status: "success" });
    applyEvent({ type: "turn_completed", session_id: 11, thread_id: 1, status: "success" });
    await vi.waitFor(() => {
      expect(chatStore.slice(2).completedTurnAttention).toBe(true);
      expect(chatStore.slice(1).completedTurnAttention).toBe(true);
    });
  });
});

describe("applyEvent native notifications", () => {
  it("notifies unless the finished chat is the one on screen", async () => {
    const { applyEvent } = await import("./reducer");
    const { nav } = await import("./nav");
    const { threadsStore } = await import("./threads");

    threadsStore.setThreads("antix", [
      {
        id: 2,
        provider: "claude",
        title: "fix the parser",
        status: "idle",
        model: "claude-opus-5",
        fast_mode: false,
        updated_at: "1",
      },
    ]);
    nav.setWindowFocused(true);
    nav.selectWorkspace("antix");
    nav.selectChatThread(2);

    // The chat you are looking at narrates its own turn ending.
    applyEvent({ type: "turn_completed", session_id: 11, thread_id: 2, status: "success" });
    expect(api.notify).not.toHaveBeenCalled();

    // A turn finishing in a chat that is not on screen is the whole reason to
    // run several at once, focused window or not.
    applyEvent({ type: "turn_completed", session_id: 12, thread_id: 7, status: "success" });
    expect(api.notify).toHaveBeenCalledTimes(1);

    nav.setWindowFocused(false);
    applyEvent({
      type: "turn_completed",
      session_id: 11,
      thread_id: 2,
      status: "success",
      duration_ms: 252_000,
    });
    expect(api.notify).toHaveBeenCalledTimes(2);
    // The thread list supplies the workspace, title and model.
    expect(api.notify).toHaveBeenLastCalledWith({
      id: "turn-11-2-success",
      title: "antix \u00b7 fix the parser",
      body: "Done in 4m 12s \u00b7 Claude Opus 5",
    });
  });
});

describe("applyEvent workspace renames", () => {
  it("follows a server-side rename so the open workspace does not go blank", async () => {
    const { applyEvent } = await import("./reducer");
    const { nav } = await import("./nav");

    nav.selectWorkspace("berlin");
    applyEvent({ type: "workspace_renamed", old_name: "berlin", new_name: "billing-webhook-fix" });

    expect(nav.selectedWorkspace()).toBe("billing-webhook-fix");
  });

  it("leaves selection alone when a different workspace is renamed", async () => {
    const { applyEvent } = await import("./reducer");
    const { nav } = await import("./nav");

    nav.selectWorkspace("berlin");
    applyEvent({ type: "workspace_renamed", old_name: "oslo", new_name: "parser-cleanup" });

    expect(nav.selectedWorkspace()).toBe("berlin");
  });
});
