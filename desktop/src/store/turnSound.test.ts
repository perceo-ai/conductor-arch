// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// End to end through the reducer: daemon events → snapshot/projection pulls →
// the per-chat busy selector → the falling-edge sound. The daemon is a mutable
// fake so each test can walk a chat through a turn.

vi.mock("@/lib/turnSoundPlayer", () => ({ playTurnSound: vi.fn() }));

interface FakeChat {
  live_session?: { session_id: number; status: string; runtime_state: string; ready: boolean };
  items: { id: string; render_class: string; status: string; parent_id?: string | null }[];
}

let daemon: Record<number, FakeChat>;
let dnd: boolean;

const STREAMING = { session_id: 10, status: "running", runtime_state: "streaming", ready: false };
const READY = { session_id: 10, status: "ready", runtime_state: "idle", ready: true };
const subagent = (status: string) => ({ id: "sub-1", render_class: "subagent_card", status });

beforeEach(() => {
  vi.resetModules();
  daemon = {};
  dnd = false;
  const api = {
    request: vi.fn(async (req: { type: string; thread_id?: number }) => {
      const chat = daemon[req.thread_id ?? -1] ?? { items: [] };
      if (req.type === "get_chat_snapshot") {
        return {
          type: "chat_snapshot",
          snapshot: {
            thread_id: req.thread_id,
            messages: [],
            events: [],
            provider_events: [],
            queued_inputs: [],
            live_session: chat.live_session,
          },
        };
      }
      if (req.type === "get_chat_projection") {
        return {
          type: "chat_projection",
          thread_id: req.thread_id,
          items: chat.items.map((item, i) => ({
            sequence: i,
            role_label: "",
            title: "",
            body: "",
            stream_state: "complete",
            ...item,
          })),
        };
      }
      if (req.type === "list_workspaces") return { type: "workspaces", workspaces: [] };
      return { type: "ack" };
    }),
    notify: vi.fn(async () => ({ ok: true })),
    doNotDisturb: vi.fn(async () => dnd),
    log: vi.fn(),
  };
  (globalThis as unknown as { window: unknown }).window = { archductor: api };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

async function setup() {
  const reducer = await import("./reducer");
  const { nav } = await import("./nav");
  const { prefsStore } = await import("./prefs");
  const { playTurnSound } = await import("@/lib/turnSoundPlayer");
  const play = vi.mocked(playTurnSound);
  play.mockClear();
  /** Set the daemon's state for a chat and let the renderer pull it. */
  const daemonSays = async (threadId: number, chat: FakeChat) => {
    daemon[threadId] = chat;
    reducer.applyEvent({ type: "turn_completed", session_id: 10, thread_id: threadId, status: "completed" });
    await settle();
  };
  return { ...reducer, nav, prefsStore, play, daemonSays };
}

describe("turn-finished sound", () => {
  it("fires once when a chat with no subagents finishes", async () => {
    const { daemonSays, play } = await setup();
    await daemonSays(1, { live_session: STREAMING, items: [] });
    expect(play).not.toHaveBeenCalled();
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).toHaveBeenCalledTimes(1);
    // A re-pull of the same idle state (refresh, reconnect) does not repeat it.
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("waits for the last subagent when the main agent finishes first", async () => {
    const { daemonSays, play } = await setup();
    await daemonSays(1, { live_session: STREAMING, items: [subagent("running")] });
    await daemonSays(1, { live_session: READY, items: [subagent("running")] });
    expect(play).not.toHaveBeenCalled();
    await daemonSays(1, { live_session: READY, items: [subagent("complete")] });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("fires after a Claude subagent finishes even though its prompt row stays running", async () => {
    const { daemonSays, play } = await setup();
    const agent = "claude:sess_tasks:toolu_agent";
    const prompt = { id: "p", render_class: "subagent_card", status: "running", parent_id: agent };
    await daemonSays(1, { live_session: STREAMING, items: [prompt] });
    await daemonSays(1, {
      live_session: READY,
      items: [prompt, { id: "r", render_class: "nested_transcript_card", status: "complete", parent_id: agent }],
    });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("fires for a background chat that is not the one on screen", async () => {
    const { daemonSays, play, nav } = await setup();
    nav.setWindowFocused(true);
    nav.selectChatThread(2);
    await daemonSays(1, { live_session: STREAMING, items: [] });
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("fires when the session exits mid-turn", async () => {
    const { daemonSays, play, applyEvent } = await setup();
    await daemonSays(1, { live_session: STREAMING, items: [] });
    applyEvent({ type: "session_exited", session_id: 10, thread_id: 1 } as never);
    await settle();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("is silenced by the setting", async () => {
    const { daemonSays, play, prefsStore } = await setup();
    prefsStore.setTurnSound(false);
    await daemonSays(1, { live_session: STREAMING, items: [] });
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).not.toHaveBeenCalled();
  });

  it("is silenced while the OS reports do-not-disturb", async () => {
    const { daemonSays, play } = await setup();
    dnd = true;
    await daemonSays(1, { live_session: STREAMING, items: [] });
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).not.toHaveBeenCalled();
  });

  it("optionally stays quiet for the chat on screen in a focused window", async () => {
    const { daemonSays, play, nav, prefsStore } = await setup();
    prefsStore.setTurnSoundSuppressWhenViewing(true);
    nav.selectWorkspace("berlin");
    nav.selectChatThread(1);
    nav.setWindowFocused(true);
    await daemonSays(1, { live_session: STREAMING, items: [] });
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).not.toHaveBeenCalled();

    // Same chat, window in the background: the operator is not looking.
    nav.setWindowFocused(false);
    await daemonSays(1, { live_session: STREAMING, items: [] });
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).toHaveBeenCalledTimes(1);
  });
});
