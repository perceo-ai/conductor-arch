// Rate limiter for whole-thread refreshes.
//
// `session_messages_updated` is emitted once per provider event, and a Claude
// or Codex turn emits one per streamed token. Answering each of them with a
// snapshot + projection pull means the renderer spends an active turn doing
// nothing but re-reading the entire thread, and the cost of one pull grows with
// the length of the chat. Isolated updates must still land immediately — a
// queued input appearing is not something to sit on — so the first request runs
// at once and the burst behind it collapses into one trailing run per interval.

export interface RefreshCoalescerOptions {
  /** Minimum gap between two runs for the same key. */
  intervalMs: number;
  now?: () => number;
  schedule?: (fn: () => void, delayMs: number) => void;
}

export interface RefreshCoalescer<K> {
  /** Run now if the key is outside its interval, otherwise run once at the end of it. */
  request(key: K): void;
  /** Run now regardless, and restart the interval (for turn boundaries). */
  flush(key: K): void;
  /** Keys with a trailing run still owed. */
  pendingKeys(): K[];
}

export function createRefreshCoalescer<K>(
  run: (key: K) => void,
  options: RefreshCoalescerOptions,
): RefreshCoalescer<K> {
  const { intervalMs } = options;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn, delayMs) => void setTimeout(fn, delayMs));
  const lastRunAt = new Map<K, number>();
  // Bumped on every run, so a trailing callback that a `flush` overtook can
  // recognise that its work is already done and skip a redundant pull.
  const generation = new Map<K, number>();
  const scheduledFor = new Map<K, number>();

  function runNow(key: K) {
    lastRunAt.set(key, now());
    generation.set(key, (generation.get(key) ?? 0) + 1);
    scheduledFor.delete(key);
    run(key);
  }

  return {
    request(key: K) {
      // Already waiting out an interval — the trailing run covers this.
      if (scheduledFor.has(key)) return;
      const last = lastRunAt.get(key);
      const elapsed = last == null ? Infinity : now() - last;
      if (elapsed >= intervalMs) {
        runNow(key);
        return;
      }
      const scheduledGeneration = generation.get(key) ?? 0;
      scheduledFor.set(key, scheduledGeneration);
      schedule(() => {
        if (scheduledFor.get(key) !== scheduledGeneration) return;
        runNow(key);
      }, intervalMs - elapsed);
    },

    flush(key: K) {
      runNow(key);
    },

    pendingKeys() {
      return [...scheduledFor.keys()];
    },
  };
}
