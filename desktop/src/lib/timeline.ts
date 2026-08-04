import type { ArchcarProjectionItem } from "@/bridge/protocol";
import { isRenderableClass } from "./chatFormat";

// Text bubbles (assistant + reasoning) only render once finalized; everything
// else — command/process/diff/tool cards, user input — renders live so the user
// sees a command the moment it runs, then its final output.
const TEXT_FINALIZED_ONLY = new Set(["assistant_chat", "reasoning_card"]);

export function isDisplayableTimelineItem(item: ArchcarProjectionItem): boolean {
  // Strict allowlist (GTK parity): only known text + inline-event classes render;
  // anything else is ditched rather than shown as a raw event.
  if (!isRenderableClass(item.render_class)) return false;
  if (TEXT_FINALIZED_ONLY.has(item.render_class)) {
    return item.stream_state === "complete";
  }
  return true;
}
