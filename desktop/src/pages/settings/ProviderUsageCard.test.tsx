// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import type { ProviderUsageReport } from "@/bridge/protocol";

const send = vi.fn();
vi.mock("@/bridge/client", () => ({
  send: (...args: unknown[]) => send(...args),
  openExternal: vi.fn(),
}));

const { ProviderUsageCard, headline, resetLabel } = await import("./ProviderUsageCard");

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  send.mockReset();
});

function report(overrides: Partial<ProviderUsageReport> = {}): ProviderUsageReport {
  return {
    provider_key: "claude",
    display_name: "Claude Code",
    status: "ok",
    plan: "Max",
    meters: [
      { label: "This week", percent_used: 38, resets_at: 1_794_196_800, severity: "normal" },
      { label: "Fable", percent_used: 15, resets_at: 1_794_196_800, severity: "normal" },
    ],
    checked_at: 1_793_000_000,
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ProviderUsageCard", () => {
  it("renders a bar per limit window, sized by percent used", async () => {
    send.mockResolvedValue({ type: "provider_usage", providers: [report()], collected_at: 1 });
    const host = document.createElement("div");
    document.body.append(host);

    dispose = render(() => <ProviderUsageCard />, host);
    await flush();

    expect(send).toHaveBeenCalledWith({ type: "get_provider_usage", refresh: false });
    const bars = host.querySelectorAll<HTMLElement>(".usage-meter-fill");
    expect(bars.length).toBe(2);
    expect(bars[0].style.width).toBe("38%");
    expect(bars[1].style.width).toBe("15%");
    expect(host.textContent).toContain("Claude Code");
    expect(host.textContent).toContain("Max");
    expect(host.textContent).toContain("38% used");
  });

  it("explains a provider that cannot report instead of drawing empty bars", async () => {
    send.mockResolvedValue({
      type: "provider_usage",
      providers: [
        report({
          provider_key: "codex",
          display_name: "Codex",
          status: "unsupported",
          plan: null,
          meters: [],
          message: "Codex is signed in with an API key, which bills per token.",
          manage_url: "https://platform.openai.com/usage",
        }),
      ],
      collected_at: 1,
    });
    const host = document.createElement("div");
    document.body.append(host);

    dispose = render(() => <ProviderUsageCard />, host);
    await flush();

    expect(host.querySelectorAll(".usage-meter-fill").length).toBe(0);
    expect(host.textContent).toContain("bills per token");
    expect(host.textContent).toContain("Open Codex usage");
  });
});

describe("headline", () => {
  it("leads with the window closest to running out", () => {
    expect(headline(report())).toBe("On track. 62% left on this week.");
    expect(
      headline(report({ meters: [{ label: "This week", percent_used: 88, severity: "warning" }] })),
    ).toBe("12% left on this week.");
    expect(
      headline(report({ meters: [{ label: "This week", percent_used: 99, severity: "critical" }] })),
    ).toBe("Out of room on this week.");
  });

  it("falls back to the provider's own message when there is nothing to draw", () => {
    expect(headline(report({ status: "unauthenticated", meters: [], message: "Run `claude`." }))).toBe(
      "Run `claude`.",
    );
  });
});

describe("resetLabel", () => {
  const now = Date.UTC(2026, 10, 5, 12, 0, 0);

  it("names the weekday inside a week and the date past it", () => {
    // Epoch SECONDS, the archcar convention — a millisecond value here would
    // land in the year 58,000 and read as a date far in the future.
    const sunday = Math.floor(Date.UTC(2026, 10, 8, 20, 0, 0) / 1000);
    expect(resetLabel(sunday, now)).toMatch(/^Resets Sunday /);

    const later = Math.floor(Date.UTC(2026, 11, 20, 20, 0, 0) / 1000);
    expect(resetLabel(later, now)).toMatch(/^Resets Dec 20$/);
  });

  it("says a window already past is resetting now", () => {
    expect(resetLabel(Math.floor(now / 1000) - 60, now)).toBe("Resetting now");
  });
});
