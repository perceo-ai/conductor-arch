// Which daemon the renderer is currently talking to, as a monotonic counter.
//
// Switching daemons does not cancel requests already in flight. A `list_layout
// _presets` sent to daemon A can land after the user has switched to daemon B,
// and applying it would replace B's presets with A's, activate one of A's
// layouts, or persist an A preset id as B's selection. The store that owns the
// request captures the epoch before awaiting and drops the response if it has
// moved on.
//
// This lives in its own module rather than in `clients.ts` because `clients.ts`
// imports the stores it re-pulls after a switch, so those stores cannot import
// it back.

let epoch = 0;

/** The epoch to capture before an await, and compare against after it. */
export function daemonEpoch(): number {
  return epoch;
}

/** Called when the active daemon changes; invalidates every in-flight response. */
export function bumpDaemonEpoch(): number {
  epoch += 1;
  return epoch;
}

/** True when the connection has changed since `captured` was taken. */
export function daemonChangedSince(captured: number): boolean {
  return captured !== epoch;
}
