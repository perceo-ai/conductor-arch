// Freshness labels for agent-maintained records. The Summary tab's whole
// promise is "this is current", so it leads with how stale the context is
// rather than an ISO timestamp the reader has to date-math themselves.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// archcar writes `created_at` / `updated_at` as unix epoch SECONDS, so most
// timestamps reaching the renderer are bare digit strings that Date.parse
// cannot read. Anything below this bound is seconds; above it, milliseconds.
const EPOCH_SECONDS_MAX = 1e11;

function parseTimestamp(value: string): number {
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n < EPOCH_SECONDS_MAX ? n * 1000 : n;
  }
  return Date.parse(text);
}

/**
 * Render `value` as an age relative to `now` ("just now", "44m ago", "5d ago").
 * Accepts an ISO string or an epoch timestamp. Past a week the age stops being
 * useful, so it falls back to the calendar date. Unparseable input is returned
 * verbatim — a raw daemon string is more honest than "Invalid Date".
 */
export function relativeTime(value: string, now: number = Date.now()): string {
  const at = parseTimestamp(value);
  if (Number.isNaN(at)) return value;

  // Clamp at zero: the daemon's clock can run slightly ahead of the renderer's,
  // and "-3m ago" reads as a bug.
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d ago`;
  return new Date(at).toISOString().slice(0, 10);
}
