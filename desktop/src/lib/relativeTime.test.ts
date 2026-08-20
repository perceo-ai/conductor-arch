import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const NOW = Date.parse("2026-08-19T12:00:00Z");

describe("relativeTime", () => {
  it("collapses anything under a minute to 'just now'", () => {
    expect(relativeTime("2026-08-19T12:00:00Z", NOW)).toBe("just now");
    expect(relativeTime("2026-08-19T11:59:31Z", NOW)).toBe("just now");
  });

  it("counts whole minutes, hours, and days", () => {
    expect(relativeTime("2026-08-19T11:59:00Z", NOW)).toBe("1m ago");
    expect(relativeTime("2026-08-19T11:16:00Z", NOW)).toBe("44m ago");
    expect(relativeTime("2026-08-19T11:00:00Z", NOW)).toBe("1h ago");
    expect(relativeTime("2026-08-19T01:00:00Z", NOW)).toBe("11h ago");
    expect(relativeTime("2026-08-18T12:00:00Z", NOW)).toBe("1d ago");
    expect(relativeTime("2026-08-14T12:00:00Z", NOW)).toBe("5d ago");
  });

  it("falls back to a calendar date past a week", () => {
    expect(relativeTime("2026-07-30T09:15:00Z", NOW)).toBe("2026-07-30");
  });

  // archcar writes naive local timestamps ("2026-08-19 11:30:00") in some
  // columns; Date.parse handles those with a space instead of the ISO "T".
  it("accepts space-separated timestamps", () => {
    expect(relativeTime("2026-08-19 11:30:00Z", NOW)).toBe("30m ago");
  });

  // archcar stores every `created_at` / `updated_at` as unix epoch SECONDS
  // (see the summaries/tasks tables), so the wire value is a bare digit string
  // that Date.parse cannot read.
  it("reads archcar's epoch-seconds timestamps", () => {
    const seconds = String(Math.floor(NOW / 1000) - 44 * 60);
    expect(relativeTime(seconds, NOW)).toBe("44m ago");
  });

  it("reads epoch milliseconds too", () => {
    expect(relativeTime(String(NOW - 2 * 60 * 60 * 1000), NOW)).toBe("2h ago");
  });

  it("returns the raw text when it is not a timestamp", () => {
    expect(relativeTime("", NOW)).toBe("");
    expect(relativeTime("never", NOW)).toBe("never");
  });

  // A clock skew between the daemon and the renderer must not render "-3m ago".
  it("treats future timestamps as just now", () => {
    expect(relativeTime("2026-08-19T12:05:00Z", NOW)).toBe("just now");
  });
});
