/**
 * Ordered, coalescing writer for terminal keystrokes.
 *
 * Each keystroke used to become its own `send_input` RPC, fired without waiting
 * for the previous one. Nothing in that path preserves order — the calls race
 * through IPC and the daemon socket independently — so typing faster than the
 * round-trip produced transposed characters: `printf` arriving as `pirnft`. It
 * is worst on a remote daemon and on paste, where a whole line is delivered as
 * a burst of individual events.
 *
 * This keeps exactly one request in flight per terminal and accumulates
 * everything typed meanwhile into the next one. That both fixes the ordering
 * (a single writer, strictly sequential) and collapses a burst into one RPC
 * instead of one per character.
 */
export interface TerminalInputQueue {
  /** Queue data for delivery. Returns once queued, not once sent. */
  write(data: string): void;
  /** Resolves when everything queued so far has been sent. For tests. */
  drain(): Promise<void>;
  /** Drop anything not yet sent; used when the terminal goes away. */
  dispose(): void;
}

export function createTerminalInputQueue(
  send: (data: string) => Promise<unknown>,
): TerminalInputQueue {
  let buffer = "";
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  async function pump(): Promise<void> {
    // Re-read `buffer` each turn: anything typed while the previous request was
    // in flight is picked up here, in order, as one payload.
    while (!disposed && buffer.length > 0) {
      const payload = buffer;
      buffer = "";
      try {
        await send(payload);
      } catch {
        // A dropped keystroke must not wedge the queue — the session is either
        // gone (in which case nothing more will be typed into it) or the next
        // write will retry the transport.
      }
    }
    inFlight = null;
  }

  return {
    write(data: string) {
      if (disposed || data === "") return;
      buffer += data;
      // Start a pump only if one is not already draining; otherwise the running
      // pump will pick this up, which is what keeps a single writer.
      if (!inFlight) inFlight = pump();
    },
    async drain() {
      while (inFlight) await inFlight;
    },
    dispose() {
      disposed = true;
      buffer = "";
    },
  };
}
