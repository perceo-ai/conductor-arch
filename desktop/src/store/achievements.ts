import { createSignal } from "solid-js";
import { send } from "@/bridge/client";
import type { AchievementsSummary } from "@/bridge/protocol";
import { daemonChangedSince, daemonEpoch } from "./daemonEpoch";

// Achievements are a toy, and the store is built to stay one: nothing is
// pushed, nothing subscribes, nothing refreshes in the background. The daemon
// derives the whole summary from rows it already has, so the only cost is one
// RPC when a human opens the page — and the answer is cached until it goes
// stale or the page is reopened past the TTL.

/** How long a loaded summary is considered fresh enough to show as-is. */
const STALE_AFTER_MS = 60_000;

const [summary, setSummary] = createSignal<AchievementsSummary>();
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<string>();
let loadedAt = 0;
// Achievements belong to a daemon, so the cache and the shared request are both
// scoped to the epoch they were read under. Time alone cannot say a summary is
// still good: a switch inside the TTL would keep showing the previous machine.
let cacheEpoch = daemonEpoch();
let inFlight: { epoch: number; request: Promise<void> } | undefined;

/** Drop whatever the previous daemon left behind, before reading the cache. */
function forgetPreviousDaemon(): void {
  if (!daemonChangedSince(cacheEpoch)) return;
  cacheEpoch = daemonEpoch();
  setSummary(undefined);
  setError(undefined);
  loadedAt = 0;
  inFlight = undefined;
  setLoading(false);
}

async function fetchSummary(epoch: number): Promise<void> {
  setLoading(true);
  setError(undefined);
  try {
    const response = await send({ type: "get_achievements" });
    if (daemonChangedSince(epoch)) return;
    if (response.type === "error") {
      setError(response.message);
      return;
    }
    if (response.type !== "achievements") {
      setError(`unexpected response: ${response.type}`);
      return;
    }
    setSummary(response.summary);
    loadedAt = Date.now();
  } catch (err) {
    if (daemonChangedSince(epoch)) return;
    setError(err instanceof Error ? err.message : String(err));
  }
}

export const achievementsStore = {
  summary,
  loading,
  error,

  /** Load once; re-fetch only when the cached summary is stale. */
  async load(): Promise<void> {
    forgetPreviousDaemon();
    if (summary() && Date.now() - loadedAt < STALE_AFTER_MS) return;
    return this.refresh();
  },

  /** Force a re-read. Concurrent callers to one daemon share the one request. */
  async refresh(): Promise<void> {
    forgetPreviousDaemon();
    const epoch = daemonEpoch();
    if (inFlight?.epoch === epoch) return inFlight.request;
    const request = fetchSummary(epoch).finally(() => {
      // A request superseded by a switch must not end the load that replaced it.
      if (inFlight?.request !== request) return;
      inFlight = undefined;
      setLoading(false);
    });
    inFlight = { epoch, request };
    return request;
  },

  /**
   * The active daemon changed. A later `load` would catch this too, but one is
   * not guaranteed: a failed inventory pull leaves this page mounted.
   */
  daemonChanged(): void {
    forgetPreviousDaemon();
  },

  /** Test seam: forget the cache so the next `load` goes to the daemon. */
  reset(): void {
    setSummary(undefined);
    setError(undefined);
    loadedAt = 0;
  },
};
