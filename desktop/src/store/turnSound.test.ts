// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// End to end through the reducer: daemon events → snapshot/projection pulls →
// the per-chat busy selector → the falling-edge sound. The daemon is a mutable
// fake so each test can walk a chat through a turn.

vi.mock("@/lib/turnSoundPlayer", () => ({ playTurnSound: vi.fn() }));

interface FakeChat {
  live_session?: { session_id: number; status: string; runtime_state: string; ready: boolean };
  items: {
    id: string;
    render_class: string;
    status: string;
    parent_id?: string | null;
    background_agent?: boolean;
  }[];
}

let daemon: Record<number, FakeChat>;
let dnd: boolean;
/** Answer delay for every request; the state is still read when it is sent. */
let latencyMs: number;
/** Fail the next N `get_chat_projection` requests. */
let failProjections: number;
/** When set, `doNotDisturb` waits for this before answering. */
let dndGate: Promise<void> | null;

const STREAMING = { session_id: 10, status: "running", runtime_state: "streaming", ready: false };
const READY = { session_id: 10, status: "ready", runtime_state: "idle", ready: true };
const subagent = (status: string) => ({ id: "sub-1", render_class: "subagent_card", status });

beforeEach(() => {
  vi.resetModules();
  daemon = {};
  dnd = false;
  latencyMs = 0;
  failProjections = 0;
  dndGate = null;
  const api = {
    request: vi.fn(async (req: { type: string; thread_id?: number }) => {
      const chat = daemon[req.thread_id ?? -1] ?? { items: [] };
      const fail = req.type === "get_chat_projection" && failProjections > 0;
      if (fail) failProjections -= 1;
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      if (fail) throw new Error("daemon went away mid-pull");
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
    doNotDisturb: vi.fn(async () => {
      if (dndGate) await dndGate;
      return dnd;
    }),
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

  it("fires for a short turn that starts and finishes before any snapshot pull sees it busy", async () => {
    const { applyEvent, play, daemonSays } = await setup();
    // No prior pull for this thread yet, so the module has no busy baseline.
    // session_started must record one on its own, independent of the (still
    // unfired) debounced snapshot pull.
    applyEvent({
      type: "session_started",
      thread_id: 1,
      session_id: 10,
      workspace: "berlin",
      kind: "claude",
    } as never);
    // By the time the pull resolves the turn has already finished.
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not chime when the daemon replays an already-idle session on reconnect", async () => {
    const { applyEvent, play, daemonSays } = await setup();
    // Simulate the reconnect replay: SessionStarted(replayed) immediately followed by
    // SessionReady, for a session that was already idle before this client connected.
    applyEvent({
      type: "session_started",
      thread_id: 1,
      session_id: 10,
      workspace: "berlin",
      kind: "claude",
      replayed: true,
      ready: true,
    } as never);
    applyEvent({ type: "session_ready", session_id: 10, thread_id: 1 } as never);
    // The debounced pull that follows sees an idle session with no history of real work.
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).not.toHaveBeenCalled();
  });

  it("still chimes when a replayed session is genuinely active and finishes later", async () => {
    const { applyEvent, play, daemonSays } = await setup();
    // Reconnect lands while this chat's agent is still mid-turn (not ready yet).
    applyEvent({
      type: "session_started",
      thread_id: 1,
      session_id: 10,
      workspace: "berlin",
      kind: "claude",
      replayed: true,
      ready: false,
    } as never);
    // The turn finishes before any other pull ever observed it busy.
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not chime when a replayed session was already waiting on a question", async () => {
    const { applyEvent, play, daemonSays } = await setup();
    // The daemon reports a Claude agent parked on a question as not ready but
    // waiting_for_input (mark_snapshot_awaiting_input). That is not work.
    const waiting = { session_id: 10, status: "running", runtime_state: "waiting_for_input", ready: false };
    applyEvent({
      type: "session_started",
      thread_id: 1,
      session_id: 10,
      workspace: "berlin",
      kind: "claude",
      replayed: true,
      ready: false,
      runtime_state: "waiting_for_input",
    } as never);
    // Opening the chat (or any pull) loads the question; nothing finished.
    await daemonSays(1, { live_session: waiting, items: [] });
    expect(play).not.toHaveBeenCalled();
  });

  it("does not ring on reconnect while a background agent launched during the disconnect still works", async () => {
    const { applyEvent, play, daemonSays } = await setup();
    const bgAgent = (status: string) => ({
      id: "claude:s:task:agent",
      render_class: "background_card",
      status,
      background_agent: true,
    });
    // Last pull before the connection dropped: main agent busy, no subagent.
    await daemonSays(1, { live_session: STREAMING, items: [] });
    // While disconnected the main turn ended and a background agent started.
    // The event stream reconnects without a reload, so the stored cards are
    // stale when the replay lands.
    daemon[1] = { live_session: READY, items: [bgAgent("running")] };
    applyEvent({
      type: "session_started",
      thread_id: 1,
      session_id: 10,
      workspace: "berlin",
      kind: "claude",
      replayed: true,
      ready: true,
      runtime_state: "waiting_for_input",
    } as never);
    applyEvent({ type: "session_ready", session_id: 10, thread_id: 1 } as never);
    await settle();
    expect(play).not.toHaveBeenCalled();
    // A settled pull sees the agent still running; its completion is the chime.
    await daemonSays(1, { live_session: READY, items: [bgAgent("running")] });
    expect(play).not.toHaveBeenCalled();
    await daemonSays(1, { live_session: READY, items: [bgAgent("complete")] });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("fires even when a file or commit view is covering the selected chat", async () => {
    const { daemonSays, play, nav, prefsStore } = await setup();
    prefsStore.setTurnSoundSuppressWhenViewing(true);
    nav.selectWorkspace("berlin");
    nav.selectChatThread(1);
    nav.setWindowFocused(true);
    // A FileView/CommitView is open over the chat surface: the chat tab is
    // still "selected" but is not actually what's on screen.
    nav.setChatSurfaceShowsChat(false);
    await daemonSays(1, { live_session: STREAMING, items: [] });
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).toHaveBeenCalledTimes(1);
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

  it("fires when a background agent outlives the main turn, only once it finishes", async () => {
    const { daemonSays, play } = await setup();
    const bgAgent = (status: string) => ({
      id: "claude:s:task:agent",
      render_class: "background_card",
      status,
      background_agent: true,
    });
    await daemonSays(1, { live_session: STREAMING, items: [] });
    // Main turn over, the backgrounded agent still working.
    await daemonSays(1, { live_session: READY, items: [bgAgent("running")] });
    expect(play).not.toHaveBeenCalled();
    await daemonSays(1, { live_session: READY, items: [bgAgent("complete")] });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not wait on a backgrounded shell command", async () => {
    const { daemonSays, play } = await setup();
    const server = { id: "claude:s:task:bash", render_class: "background_card", status: "running" };
    await daemonSays(1, { live_session: STREAMING, items: [server] });
    await daemonSays(1, { live_session: READY, items: [server] });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("still fires when every busy pull had a follow-up queued behind it", async () => {
    const { applyEvent, play } = await setup();
    latencyMs = 20;
    daemon[1] = { live_session: STREAMING, items: [] };
    // Pull 1 goes out while the agent is streaming...
    applyEvent({ type: "turn_completed", session_id: 10, thread_id: 1, status: "completed" });
    // ...and the turn ends before it answers, so a follow-up is queued.
    daemon[1] = { live_session: READY, items: [] };
    applyEvent({ type: "turn_completed", session_id: 10, thread_id: 1, status: "completed" });
    await new Promise((r) => setTimeout(r, 120));
    await settle();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not judge a chat finished from a pull whose projection failed", async () => {
    const { daemonSays, play } = await setup();
    const bgAgent = {
      id: "claude:s:task:agent",
      render_class: "background_card",
      status: "running",
      background_agent: true,
    };
    await daemonSays(1, { live_session: STREAMING, items: [] });
    // The main agent goes idle with a background agent running, but the
    // projection half of the pull fails: the store holds a ready session and
    // the old, empty projection.
    failProjections = 1;
    await daemonSays(1, { live_session: READY, items: [bgAgent] });
    expect(play).not.toHaveBeenCalled();
    // The retry sees the agent, and its completion is the one chime.
    await daemonSays(1, { live_session: READY, items: [bgAgent] });
    expect(play).not.toHaveBeenCalled();
    await daemonSays(1, { live_session: READY, items: [{ ...bgAgent, status: "complete" }] });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not ring when switching daemons lands on an idle chat with the same id", async () => {
    const { daemonSays, play } = await setup();
    const { bumpDaemonEpoch } = await import("./daemonEpoch");
    await daemonSays(1, { live_session: STREAMING, items: [] });
    bumpDaemonEpoch();
    // Thread 1 on the new daemon is a different chat, and idle.
    await daemonSays(1, { live_session: READY, items: [] });
    expect(play).not.toHaveBeenCalled();
  });

  it("honours muting that happens while do-not-disturb is being checked", async () => {
    const { daemonSays, play, prefsStore } = await setup();
    let answer!: () => void;
    dndGate = new Promise<void>((r) => (answer = r));
    await daemonSays(1, { live_session: STREAMING, items: [] });
    await daemonSays(1, { live_session: READY, items: [] });
    prefsStore.setTurnSound(false);
    answer();
    await settle();
    expect(play).not.toHaveBeenCalled();
  });
});
