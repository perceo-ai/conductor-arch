import type { ArchcarProjectionItem } from "@/bridge/protocol";
import { isRenderableClass } from "./chatFormat";

// Assistant answer text only renders once finalized to avoid partial markdown
// churn. Reasoning/thinking and command/tool cards render live so the user can
// see what the agent is doing mid-turn.
const TEXT_FINALIZED_ONLY = new Set(["assistant_chat"]);

/**
 * Drop the assistant message a pending plan was lifted from.
 *
 * A codex plan is not a message the agent sent in addition to its answer — it
 * *is* the answer. `raise_codex_plan_approval` copies `latest_assistant_text`
 * into the interaction's `detail`, so the same markdown is stored twice, and
 * rendering the card next to its source shows the plan twice.
 *
 * Matching on content rather than on an id is what makes this safe for both
 * providers: Claude builds its plan from the `ExitPlanMode` tool input rather
 * than from the transcript, so usually nothing matches and nothing is dropped.
 *
 * Only the newest match goes — an agent that genuinely repeated itself said
 * both things, and only the last one became the card. Once the plan resolves
 * the card disappears and the message takes its place in the scrollback, so
 * the plan is never absent and never doubled.
 */
export function withoutPlanSource(
  items: ArchcarProjectionItem[],
  planDetail: string | null | undefined,
): ArchcarProjectionItem[] {
  const plan = planDetail?.trim();
  if (!plan) return items;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.render_class !== "assistant_chat") continue;
    if (item.body.trim() !== plan) continue;
    return [...items.slice(0, i), ...items.slice(i + 1)];
  }
  return items;
}

/**
 * Whether the "new chat" intro belongs on screen.
 *
 * Not simply "no items": `withoutPlanSource` can empty the list on a thread
 * whose only assistant message became the plan card, and a chat holding a plan
 * awaiting approval is the opposite of a new one.
 */
export function showsNewChatIntro(itemCount: number, hasPendingPlan: boolean): boolean {
  return itemCount === 0 && !hasPendingPlan;
}

export function isDisplayableTimelineItem(item: ArchcarProjectionItem): boolean {
  // Strict allowlist (GTK parity): only known text + inline-event classes render;
  // anything else is ditched rather than shown as a raw event.
  if (!isRenderableClass(item.render_class)) return false;
  if (TEXT_FINALIZED_ONLY.has(item.render_class)) {
    return item.stream_state === "complete";
  }
  return true;
}
