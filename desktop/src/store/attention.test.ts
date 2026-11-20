// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@/bridge/protocol";

const send = vi.fn();
vi.mock("@/bridge/client", () => ({ send }));

const { attentionStore, ATTENTION_DEBOUNCE_MS } = await import("./attention");

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    kind: "agent_asked",
    workspace: "ws",
    repository: "repo",
    thread_id: 1,
    session_id: 1,
    headline: "Agent asked a question",
    detail: null,
    rank: 0,
    ...overrides,
  };
}

function queueOf(items: AttentionItem[]) {
  return { type: "attention", queue: { generated_at: "2026-11-19T22:28:36Z", items } };
}

let unwatch: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  send.mockReset();
});

afterEach(() => {
  unwatch?.();
  unwatch = undefined;
  attentionStore.reset();
  vi.useRealTimers();
});

describe("attentionStore", () => {
  it("keeps items in the order the daemon sent them, without re-sorting", async () => {
    // Deliberately not rank order: the daemon's order is the contract.
    const sent = [
      item({ workspace: "zeta", rank: 5, kind: "diff_ready" }),
      item({ workspace: "alpha", rank: 0 }),
      item({ workspace: "mid", rank: 2, kind: "task_finished" }),
    ];
    send.mockResolvedValue(queueOf(sent));
    await attentionStore.refresh();
    expect(attentionStore.items().map((i) => i.workspace)).toEqual(["zeta", "alpha", "mid"]);
    expect(attentionStore.generatedAt()).toBe("2026-11-19T22:28:36Z");
  });

  it("coalesces a burst of events into one fetch", async () => {
    send.mockResolvedValue(queueOf([item()]));
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1); // the on-open load
    send.mockClear();

    for (let i = 0; i < 25; i++) attentionStore.invalidate();
    await vi.advanceTimersByTimeAsync(ATTENTION_DEBOUNCE_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ATTENTION_DEBOUNCE_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not fetch for events while nobody is looking, but catches up on open", async () => {
    send.mockResolvedValue(queueOf([item()]));
    attentionStore.invalidate();
    await vi.advanceTimersByTimeAsync(ATTENTION_DEBOUNCE_MS * 2);
    expect(send).not.toHaveBeenCalled();
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(attentionStore.items()).toHaveLength(1);
  });

  it("runs one follow-up fetch for events that land while a fetch is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    send.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    attentionStore.invalidate();
    await vi.advanceTimersByTimeAsync(ATTENTION_DEBOUNCE_MS + 1);
    expect(send).toHaveBeenCalledTimes(1); // still the one in flight; no overlap

    send.mockResolvedValue(queueOf([item()]));
    release(queueOf([]));
    await vi.advanceTimersByTimeAsync(ATTENTION_DEBOUNCE_MS + 1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("surfaces a fetch error without clearing the last good list", async () => {
    send.mockResolvedValueOnce(queueOf([item({ headline: "still here" })]));
    await attentionStore.refresh();
    send.mockRejectedValueOnce(new Error("daemon down"));
    await attentionStore.refresh();
    expect(attentionStore.error()).toBe("daemon down");
    expect(attentionStore.items().map((i) => i.headline)).toEqual(["still here"]);

    send.mockResolvedValueOnce({ type: "error", message: "boom" });
    await attentionStore.refresh();
    expect(attentionStore.error()).toBe("boom");
    expect(attentionStore.items()).toHaveLength(1);

    send.mockResolvedValueOnce(queueOf([]));
    await attentionStore.refresh();
    expect(attentionStore.error()).toBeUndefined();
    expect(attentionStore.items()).toEqual([]);
  });

  it("stays retryable after a failed fetch: reopening the page tries again", async () => {
    send.mockRejectedValueOnce(new Error("daemon down"));
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(attentionStore.error()).toBe("daemon down");
    unwatch();

    send.mockResolvedValue(queueOf([item()]));
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(attentionStore.error()).toBeUndefined();
    expect(attentionStore.items()).toHaveLength(1);
  });

  it("stays retryable after the daemon answers with an error", async () => {
    send.mockResolvedValueOnce({ type: "error", message: "boom" });
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    unwatch();
    send.mockResolvedValue(queueOf([]));
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(attentionStore.error()).toBeUndefined();
  });

  it("refetches on every reopen even when no event arrived (the queue is clock-derived)", async () => {
    send.mockResolvedValue(queueOf([item()]));
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    unwatch();
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    unwatch();
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("reports a refetch as owed from the moment it is queued, so empty is not shown as fact", async () => {
    send.mockResolvedValue(queueOf([]));
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(attentionStore.owed()).toBe(false);
    attentionStore.invalidate();
    expect(attentionStore.owed()).toBe(true);
    await vi.advanceTimersByTimeAsync(ATTENTION_DEBOUNCE_MS + 1);
    expect(attentionStore.owed()).toBe(false);
  });

  it("a second watcher opening after a failure retries (the fetch's own stale flag, not unwatch)", async () => {
    send.mockRejectedValueOnce(new Error("daemon down"));
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(attentionStore.error()).toBe("daemon down");
    // First watcher is still mounted, so no unwatch has marked anything stale.
    send.mockResolvedValue(queueOf([item()]));
    const second = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(attentionStore.error()).toBeUndefined();
    second();
  });

  it("a manual refresh inside the debounce window cancels the pending timer", async () => {
    send.mockResolvedValue(queueOf([]));
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    send.mockClear();
    attentionStore.invalidate();
    await vi.advanceTimersByTimeAsync(500);
    await attentionStore.refresh();
    expect(send).toHaveBeenCalledTimes(1);
    expect(attentionStore.owed()).toBe(false);
    await vi.advanceTimersByTimeAsync(ATTENTION_DEBOUNCE_MS * 2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("runs no hidden fetch after close, and always refetches on reopen", async () => {
    // An event's follow-up timer can fire while the original read (from
    // opening the page) is still in flight: `run()` then only sets `rerun`,
    // since a fetch is already running. If the page closes before that
    // original read finishes, its `finally` must not schedule a follow-up
    // anyway — nobody is watching, so such a read would be hidden, and
    // `fetchQueue` marks `stale = false` as soon as it starts, which would
    // wrongly tell a later `watch()` the list is already fresh.
    let resolveFirst: (v: unknown) => void = () => {};
    send.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1); // the on-open read, still in flight

    // An event lands while that read is in flight and a watcher is present.
    attentionStore.invalidate();
    // The follow-up timer fires before the original read resolves: `run()`
    // sees `inFlight` and only sets `rerun`, costing no extra fetch yet.
    await vi.advanceTimersByTimeAsync(ATTENTION_DEBOUNCE_MS + 1);
    expect(send).toHaveBeenCalledTimes(1);

    // The page closes before the original read resolves.
    unwatch();
    unwatch = undefined;

    // The original read now resolves, with nobody watching.
    send.mockResolvedValue(queueOf([item()]));
    resolveFirst(queueOf([]));
    await vi.advanceTimersByTimeAsync(ATTENTION_DEBOUNCE_MS + 1);

    // No hidden fetch must have run while the page was closed.
    expect(send).toHaveBeenCalledTimes(1);

    // Reopening always refetches (the queue is partly clock-derived) --
    // which also proves `stale` was not wrongly cleared by a hidden read.
    unwatch = attentionStore.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
  });
});