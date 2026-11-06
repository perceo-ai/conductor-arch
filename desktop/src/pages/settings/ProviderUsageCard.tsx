import { For, Show, createResource, createSignal } from "solid-js";
import { openExternal, send } from "@/bridge/client";
import type { ProviderUsageReport, UsageMeter } from "@/bridge/protocol";

// Usage pane: how much plan quota is left for each agent provider signed in on
// the daemon's machine. The daemon reads the credentials each provider's CLI
// already stored and asks that provider's own account endpoint, so this answers
// the same question `/usage` answers inside Claude Code — without opening a
// session to ask it.
//
// A provider that is signed out, or signed in a way that has no plan quota
// (an API key bills per token), reports that instead of an empty bar.

/** Epoch seconds; archcar never sends ISO strings for these. */
export function resetLabel(resetsAt: number, now: number = Date.now()): string {
  const at = resetsAt * 1000;
  if (!Number.isFinite(at)) return "";
  const elapsed = at - now;
  if (elapsed <= 0) return "Resetting now";
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // Inside a week a weekday reads faster than a date; past that it stops
  // meaning anything and the calendar date is the honest answer.
  if (elapsed < 7 * 24 * 60 * 60 * 1000) {
    const sameDay = new Date(now).toDateString() === date.toDateString();
    const day = sameDay ? "today" : date.toLocaleDateString(undefined, { weekday: "long" });
    return `Resets ${day} ${time}`;
  }
  return `Resets ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** The one line a glance should answer: is there room left, and until when? */
export function headline(report: ProviderUsageReport): string {
  if (report.status !== "ok") return report.message ?? "No usage available.";
  if (report.meters.length === 0) return report.message ?? "No active limit window.";
  const worst = report.meters.reduce((a, b) => (b.percent_used > a.percent_used ? b : a));
  const left = Math.max(0, 100 - worst.percent_used);
  if (worst.percent_used >= 95) return `Out of room on ${worst.label.toLowerCase()}.`;
  if (worst.percent_used >= 80) return `${left}% left on ${worst.label.toLowerCase()}.`;
  return `On track. ${left}% left on ${worst.label.toLowerCase()}.`;
}

function MeterRow(props: { meter: UsageMeter }) {
  const meter = () => props.meter;
  return (
    <div class="usage-meter">
      <div class="usage-meter-copy">
        <div class="usage-meter-label">{meter().label}</div>
        <Show when={meter().detail}>
          <div class="usage-meter-detail">{meter().detail}</div>
        </Show>
        <Show when={meter().resets_at}>
          {(resets) => <div class="usage-meter-detail">{resetLabel(resets())}</div>}
        </Show>
      </div>
      <div
        class="usage-meter-bar"
        role="progressbar"
        aria-label={`${meter().label} usage`}
        aria-valuenow={meter().percent_used}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          class="usage-meter-fill"
          classList={{
            warning: meter().severity === "warning",
            critical: meter().severity === "critical",
          }}
          style={{ width: `${Math.max(0, Math.min(100, meter().percent_used))}%` }}
        />
      </div>
      <div class="usage-meter-value">{meter().percent_used}% used</div>
    </div>
  );
}

function ProviderBlock(props: { report: ProviderUsageReport }) {
  const report = () => props.report;
  return (
    <div class="settings-field usage-provider" classList={{ muted: report().status !== "ok" }}>
      <div class="usage-provider-head">
        <span class="settings-field-title">{report().display_name}</span>
        <Show when={report().plan}>
          <span class="usage-plan-chip">{report().plan}</span>
        </Show>
      </div>
      <div class="settings-status">{headline(report())}</div>
      <For each={report().meters}>{(meter) => <MeterRow meter={meter} />}</For>
      <Show when={report().status !== "ok" && report().manage_url}>
        {(url) => (
          <div class="settings-action-row">
            <button class="ui-button-secondary" onClick={() => void openExternal(url())}>
              Open {report().display_name} usage
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}

export function ProviderUsageCard() {
  const [refreshing, setRefreshing] = createSignal(false);
  const [usage, { refetch }] = createResource(async (_source, info: { refetching: boolean | unknown }) => {
    const res = await send({ type: "get_provider_usage", refresh: info.refetching === true });
    if (res.type !== "provider_usage") {
      throw new Error(res.type === "error" ? res.message : `unexpected response ${res.type}`);
    }
    return res.providers;
  });

  const reload = async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <Show when={usage.error}>
        <div class="settings-field">
          <div class="settings-status">Could not read provider usage: {String(usage.error)}</div>
        </div>
      </Show>
      <Show when={usage.loading && !usage()}>
        <div class="settings-field">
          <div class="settings-status">Asking each provider…</div>
        </div>
      </Show>
      <For each={usage() ?? []}>{(report) => <ProviderBlock report={report} />}</For>
      <Show when={(usage() ?? []).length > 0}>
        <div class="settings-action-row">
          <button class="ui-button-secondary" disabled={refreshing()} onClick={() => void reload()}>
            {refreshing() ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </Show>
    </>
  );
}

export default ProviderUsageCard;
