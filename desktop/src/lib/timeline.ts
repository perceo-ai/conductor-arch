import type { ArchcarProjectionItem } from "@/bridge/protocol";

// Text bubbles (assistant + reasoning) only render once finalized; everything
// else — command/process/diff/tool cards, user input — renders live so the user
// sees a command the moment it runs, then its final output.
const TEXT_FINALIZED_ONLY = new Set(["assistant_chat", "reasoning_card"]);

export function isDisplayableTimelineItem(item: ArchcarProjectionItem): boolean {
  if (TEXT_FINALIZED_ONLY.has(item.render_class)) {
    return item.stream_state === "complete";
  }
  return true;
}
