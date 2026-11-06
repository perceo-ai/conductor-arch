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
let inFlight: Promise<void> | undefined;

async function fetchSummary(): Promise<void> {
  setLoading(true);
  setError(undefined);
  // Achievements belong to a daemon. Applying a late answer after a client
  // switch would show the previous machine's numbers under the new one.
  const epoch = daemonEpoch();
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
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    setLoading(false);
  }
}

export const achievementsStore = {
  summary,
  loading,
  error,

  /** Load once; re-fetch only when the cached summary is stale. */
  async load(): Promise<void> {
    if (summary() && Date.now() - loadedAt < STALE_AFTER_MS) return;
    return this.refresh();
  },

  /** Force a re-read. Concurrent callers share the one request. */
  async refresh(): Promise<void> {
    inFlight ??= fetchSummary().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  },

  /** Test seam: forget the cache so the next `load` goes to the daemon. */
  reset(): void {
    setSummary(undefined);
    setError(undefined);
    loadedAt = 0;
  },
};
