import { For, Show, createMemo, onCleanup, onMount } from "solid-js";
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
  review_comments: "git-pull-request",
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
  review_comments: "Review comments",
  diff_ready: "Diff ready",
  idle: "Idle",
};

const TONE_LABEL: Record<Tone, string> = {
  urgent: "Needs you now",
  soon: "Worth a look",
  quiet: "When you have a moment",
};

export function AttentionPage() {
  onMount(() => {
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
        <Show when={attentionStore.generatedAt()}>
          {(at) => <div class="attention-asof">As of {relativeTime(at())}</div>}
        </Show>
      </div>

      <Show when={attentionStore.error()}>
        {(message) => <div class="attention-error">Could not refresh: {message()}</div>}
      </Show>

      <Show
        when={attentionStore.items().length > 0}
        fallback={
          <Show when={!attentionStore.loading() || attentionStore.generatedAt()}>
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
                      onClick={() => attentionStore.selectItem(item)}
                    >
                      <Icon name={KIND_ICON[item.kind]} class="attention-row-icon" />
                      <span class="attention-row-workspace">{item.workspace}</span>
                      <span class="attention-row-headline">{item.headline}</span>
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
