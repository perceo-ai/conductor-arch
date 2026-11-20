import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import Icon from "@/components/Icon";
import { attentionStore } from "@/store/attention";
import { relativeTime } from "@/lib/relativeTime";
import type { AttentionItem, AttentionKind } from "@/bridge/protocol";

// The attention surface: one ranked list of what needs the human, across every
// workspace. The daemon derives and orders it, so this page renders the list
// as given and never sorts. Layout follows the convention WorkspaceIntel.tsx
// documents: a flat scroll of quiet section labels and single-line rows on one
// surface, with no cards inside cards.

type Tone = "urgent" | "soon" | "quiet";

// THE URGENCY TAXONOMY IS A SHARED PRESENTATION CONTRACT. Every client (this
// page, the iOS app) groups items by `rank` into the same three tiers with the
// same cut points: rank 0-1 "Needs you now", 2-4 "Worth a look", 5+ "When you
// have a moment". Do not invent another grouping on a new surface.

/** Presentation comes from the item's own `kind` and `rank`, not from the CLI's marks. */
function toneOf(item: AttentionItem): Tone {
  if (item.rank <= 1) return "urgent";
  if (item.rank <= 4) return "soon";
  return "quiet";
}

const KIND_ICON: Record<AttentionKind, "circle-help" | "circle-x" | "alert-circle" | "circle-check" | "git-pull-request" | "git-compare" | "circle-dot"> = {
  agent_asked: "circle-help",
  session_failed: "circle-x",
  stalled: "alert-circle",
  task_finished: "circle-check",
  checks_failed: "circle-x",
  pr_open: "git-pull-request",
  diff_ready: "git-compare",
  idle: "circle-dot",
};

// A stalled session is alive and mid-turn but silent. A long quiet tool trips
// it as well, so it is "might be stuck", never "stuck".
const KIND_LABEL: Record<AttentionKind, string> = {
  agent_asked: "Agent asked a question",
  session_failed: "Session failed",
  stalled: "Might be stuck",
  task_finished: "Background task finished",
  checks_failed: "Checks failed",
  pr_open: "Open pull request",
  diff_ready: "Diff ready",
  idle: "Idle",
};

const TONE_LABEL: Record<Tone, string> = {
  urgent: "Needs you now",
  soon: "Worth a look",
  quiet: "When you have a moment",
};

/** How often the "as of" age is recomputed; it must not freeze at "just now". */
const ASOF_TICK_MS = 30_000;

export function AttentionPage() {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const tick = setInterval(() => setNow(Date.now()), ASOF_TICK_MS);
    onCleanup(() => clearInterval(tick));
    const unwatch = attentionStore.watch();
    onCleanup(unwatch);
  });

  // The daemon's order is kept; sections are just contiguous runs of it.
  const sections = createMemo(() => {
    const out: { tone: Tone; items: AttentionItem[] }[] = [];
    for (const item of attentionStore.items()) {
      const tone = toneOf(item);
      const last = out[out.length - 1];
      if (last && last.tone === tone) last.items.push(item);
      else out.push({ tone, items: [item] });
    }
    return out;
  });

  return (
    <div class="page-shell attention-view">
      <div class="page-header dashboard-header">
        <div class="dashboard-title">Attention</div>
        <div class="attention-header-row">
          <Show when={attentionStore.generatedAt()}>
            {(at) => <div class="attention-asof">As of {relativeTime(at(), now())}</div>}
          </Show>
          <button
            type="button"
            class="ui-button-secondary attention-refresh"
            onClick={() => void attentionStore.refresh()}
            disabled={attentionStore.loading()}
          >
            {attentionStore.loading() ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <Show when={attentionStore.error()}>
        {(message) => <div class="attention-error">Could not refresh: {message()}</div>}
      </Show>

      <Show
        when={attentionStore.items().length > 0}
        fallback={
          // Empty is only a fact once an answer is in, none is owed and the last
          // fetch did not fail (a failure means the answer is unknown).
          <Show
            when={
              attentionStore.settled() &&
              !attentionStore.loading() &&
              !attentionStore.owed() &&
              !attentionStore.error()
            }
            fallback={
              <Show when={!attentionStore.error()}>
                <div class="empty-state">Checking…</div>
              </Show>
            }
          >
            <div class="empty-state">Nothing needs you right now.</div>
          </Show>
        }
      >
        <div class="attention-list">
          <For each={sections()}>
            {(section) => (
              <>
                <div class="attention-section-label">{TONE_LABEL[section.tone]}</div>
                <For each={section.items}>
                  {(item) => (
                    <button
                      type="button"
                      class="attention-row"
                      data-attention-row
                      data-kind={item.kind}
                      data-tone={toneOf(item)}
                      title={KIND_LABEL[item.kind]}
                      disabled={!attentionStore.canOpen(item)}
                      onClick={() => attentionStore.selectItem(item)}
                    >
                      <Icon name={KIND_ICON[item.kind]} class="attention-row-icon" />
                      <span class="attention-row-workspace">{item.workspace}</span>
                      <span class="attention-row-headline">{item.headline}</span>
                      <Show when={item.detail}>
                        <span class="attention-row-detail">{item.detail}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
