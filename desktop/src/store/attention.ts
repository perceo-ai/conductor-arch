import { createSignal } from "solid-js";
import { send } from "@/bridge/client";
import type { AttentionItem } from "@/bridge/protocol";
import { daemonChangedSince, daemonEpoch } from "./daemonEpoch";
import { nav } from "./nav";
import { workspacesStore } from "./workspaces";

// The cross-project attention queue: what needs the human, across every
// workspace, most urgent first. The daemon derives and sorts it (a total order,
// so rows do not jump) and this store keeps its answer as-is: it never
// re-sorts.
//
// `list_attention` is not cheap. It runs the same status sweep as `archductor
// status` — per active workspace, several git subprocesses plus transcript
// parsing — inside the daemon's request dispatch. So the store refetches only
// while the page is open, and a burst of turn events costs one fetch: the first
// event opens a trailing window and every event inside it rides along.

/**
 * Sized from a measurement: against 30 workspaces the RPC took 10-14s on a
 * machine at load average ~130 (git itself ran ~10x slow), so an unloaded
 * sweep is on the order of a second. A window shorter than that would stack
 * requests behind each other; 2s keeps one fetch per burst and still feels
 * live. Events landing mid-fetch earn one follow-up, never an overlap.
 */
export const ATTENTION_DEBOUNCE_MS = 2000;

const [items, setItems] = createSignal<AttentionItem[]>([]);
const [generatedAt, setGeneratedAt] = createSignal<string>();
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string>();
// True once any fetch for the current daemon has come back (even a failed one),
// so the page can tell "still waiting for the first answer" from "answered".
const [settled, setSettled] = createSignal(false);
// A refetch is queued or owed behind one in flight. While true, the list on
// screen is known to be out of date and must not be presented as final.
const [owed, setOwed] = createSignal(false);

let watchers = 0;
// Something changed since the last good read; the next open must refetch.
let stale = true;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<void> | undefined;
let rerun = false;

async function fetchQueue(): Promise<void> {
  const epoch = daemonEpoch();
  stale = false;
  setLoading(true);
  try {
    const response = await send({ type: "list_attention" });
    if (daemonChangedSince(epoch)) return;
    setSettled(true);
    if (response.type === "error") {
      stale = true;
      setError(response.message);
    } else if (response.type !== "attention") {
      stale = true;
      setError(`unexpected response: ${response.type}`);
    } else {
      setItems(response.queue.items);
      setGeneratedAt(response.queue.generated_at);
      setError(undefined);
    }
  } catch (err) {
    if (daemonChangedSince(epoch)) return;
    // Nothing was read, so reopening the page must try again; with the daemon
    // down no event will arrive to mark it stale for us.
    stale = true;
    setSettled(true);
    // The last good list stays on screen; only the error is added.
    setError(err instanceof Error ? err.message : String(err));
  }
}

function run(): Promise<void> {
  if (inFlight) {
    rerun = true;
    setOwed(true);
    return inFlight;
  }
  const request = fetchQueue().finally(() => {
    inFlight = undefined;
    setLoading(false);
    if (rerun) {
      rerun = false;
      schedule();
    }
  });
  inFlight = request;
  return request;
}

function schedule(): void {
  if (timer !== undefined) return;
  setOwed(true);
  timer = setTimeout(() => {
    timer = undefined;
    setOwed(false);
    void run();
  }, ATTENTION_DEBOUNCE_MS);
}

export const attentionStore = {
  items,
  generatedAt,
  loading,
  error,
  settled,
  owed,

  /** Fetch now, sharing a request already in flight. */
  refresh(): Promise<void> {
    return run();
  },

  /**
   * Something that can change the queue happened (turn ended, session died, a
   * question was asked or answered, a background task or the chat queue moved).
   * Costs nothing while the page is closed: it only marks the list stale.
   */
  invalidate(): void {
    stale = true;
    if (watchers > 0) schedule();
  },

  /** The page is open. Loads if anything is stale; returns the unsubscribe. */
  watch(): () => void {
    watchers += 1;
    if (stale) void run();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      watchers -= 1;
      // Three of the queue's kinds are decided by the clock (idle, stalled, a
      // finished task expiring), so a quiet fleet emits no event that would
      // mark it stale. Reopening therefore always refetches.
      stale = true;
      if (watchers === 0 && timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        setOwed(false);
      }
    };
  },

  /**
   * A background task started without a workspace is reported against its
   * repository's name; there is no workspace to open for it.
   */
  canOpen(item: AttentionItem): boolean {
    return workspacesStore.row(item.workspace) !== undefined;
  },

  /** Land on the thing itself: its workspace, and its chat when it names one. */
  selectItem(item: AttentionItem): void {
    if (!attentionStore.canOpen(item)) return;
    nav.selectWorkspace(item.workspace);
    if (item.thread_id != null) nav.selectChatThread(item.thread_id);
  },

  /** The active daemon changed: the previous machine's queue is not this one's. */
  daemonChanged(): void {
    setItems([]);
    setGeneratedAt(undefined);
    setError(undefined);
    setSettled(false);
    stale = true;
    if (watchers > 0) void run();
  },

  /** Test seam. */
  reset(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    inFlight = undefined;
    rerun = false;
    stale = true;
    watchers = 0;
    setItems([]);
    setGeneratedAt(undefined);
    setError(undefined);
    setLoading(false);
    setSettled(false);
    setOwed(false);
  },
};
