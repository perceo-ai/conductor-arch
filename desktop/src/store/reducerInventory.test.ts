// @vitest-environment node
//
// Its own file on purpose. These assertions count RPCs, and the shared
// reducer.test.ts leaks work across tests — an inventory refresh started by one
// test's `turn_completed` lands a microtask later, on the next test's mock. A
// separate module keeps the counts attributable to the event under test.
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
      if (req.type === "list_chat_threads") return { type: "chat_threads", threads: [] };
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

describe("applyEvent inventory refresh cost", () => {
  // Fake timers throughout: the inventory coalescer is trailing-only, so these
  // tests are about what happens at the end of a quiet window. Real timers also
  // leak a pending refresh from one test into the next, which made the
  // assertions depend on test order.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function inventoryCalls() {
    return api.request.mock.calls
      .map(([req]) => (req as { type: string }).type)
      .filter((type) => type === "list_workspaces");
  }

  it("collapses a burst of session_started events into one inventory refresh", async () => {
    const { applyEvent } = await import("./reducer");

    for (let i = 1; i <= 10; i += 1) {
      applyEvent({
        type: "session_started",
        session_id: 100 + i,
        thread_id: i,
        workspace: `ws-${i}`,
        kind: "claude",
        pid: 1000 + i,
      });
    }
    expect(inventoryCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(250);

    // One trailing refresh for the whole burst, not one per event. Each
    // list_workspaces costs the daemon six git subprocesses per active
    // workspace, so ten of them is the difference between 450ms and 4.5s.
    expect(inventoryCalls()).toHaveLength(1);
  });

  it("does not refresh the inventory for a streamed token", async () => {
    const { applyEvent } = await import("./reducer");

    applyEvent({ type: "session_messages_updated", thread_id: 3 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(inventoryCalls()).toHaveLength(0);
  });

  it("does not refresh the inventory for a queued input", async () => {
    const { applyEvent } = await import("./reducer");

    applyEvent({ type: "chat_queue_updated", thread_id: 3 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(inventoryCalls()).toHaveLength(0);
  });

  it("refreshes the inventory immediately when a turn completes", async () => {
    const { applyEvent } = await import("./reducer");

    applyEvent({ type: "turn_completed", session_id: 11, thread_id: 2, status: "success" });

    // The end of a turn is the state the user reads; it must not wait out an
    // interval.
    await vi.advanceTimersByTimeAsync(0);
    expect(inventoryCalls()).toHaveLength(1);
  });
});

describe("chat refresh interval", () => {
  it("is 250ms", async () => {
    const { CHAT_REFRESH_INTERVAL_MS } = await import("./reducer");

    expect(CHAT_REFRESH_INTERVAL_MS).toBe(250);
  });
});

describe("applyEvent refresh ordering and scope", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function sentTypes() {
    return api.request.mock.calls.map(([req]) => (req as { type: string }).type);
  }

  it("refreshes the workspace list before the chat lists that read it", async () => {
    const order: string[] = [];
    // The renamed workspace must be in the list the chat pull reads from, or
    // nothing is pulled and the ordering assertion proves nothing.
    api.request.mockImplementation(async (req: { type: string; workspace?: string }) => {
      order.push(req.type === "list_chat_threads" ? `list_chat_threads:${req.workspace}` : req.type);
      if (req.type === "list_workspaces") {
        return {
          type: "workspaces",
          workspaces: [
            {
              id: 1,
              name: "billing-fix",
              path: "/tmp/billing-fix",
              branch: "billing-fix",
              base_ref: "main",
              status: "active",
              repository_name: "demo",
              diff_additions: 0,
              diff_deletions: 0,
              open_todos: 0,
              active_sessions: 0,
              run_running: false,
              changed_files: 0,
              updated_at: "1",
            },
          ],
        };
      }
      if (req.type === "list_chat_threads") return { type: "chat_threads", threads: [] };
      return { type: "ack" };
    });
    const { applyEvent } = await import("./reducer");

    // A rename changes which names the chat lists should be pulled for, so
    // pulling them against a stale workspace list asks for the old name.
    applyEvent({ type: "workspace_renamed", old_name: "berlin", new_name: "billing-fix" });
    await vi.advanceTimersByTimeAsync(500);

    const workspaces = order.indexOf("list_workspaces");
    const threads = order.indexOf("list_chat_threads:billing-fix");
    expect(workspaces).toBeGreaterThanOrEqual(0);
    expect(threads).toBeGreaterThanOrEqual(0);
    expect(workspaces).toBeLessThan(threads);
    // And never for the name it used to have.
    expect(order).not.toContain("list_chat_threads:berlin");
  });

  it("refreshes only the completing workspace's chat list on a turn boundary", async () => {
    const { applyEvent } = await import("./reducer");
    const { threadsStore } = await import("./threads");
    threadsStore.setThreads("berlin", [
      { id: 2, workspace: "berlin", provider: "claude", title: "t", status: "active" } as never,
    ]);

    applyEvent({ type: "turn_completed", session_id: 11, thread_id: 2, status: "success" });
    await vi.advanceTimersByTimeAsync(500);

    const threadPulls = api.request.mock.calls
      .map(([req]) => req as { type: string; workspace?: string })
      .filter((req) => req.type === "list_chat_threads");
    // One workspace, not every active one: this is the hottest lifecycle event
    // in a change whose whole purpose is fewer calls.
    expect(threadPulls).toHaveLength(1);
    expect(threadPulls[0]?.workspace).toBe("berlin");
    expect(sentTypes()).toContain("list_workspaces");
  });
});
