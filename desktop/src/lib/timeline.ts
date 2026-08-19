import type { ArchcarProjectionItem } from "@/bridge/protocol";
import { isRenderableClass } from "./chatFormat";

// Assistant answer text only renders once finalized to avoid partial markdown
// churn. Reasoning/thinking and command/tool cards render live so the user can
// see what the agent is doing mid-turn.
const TEXT_FINALIZED_ONLY = new Set(["assistant_chat"]);

export function isDisplayableTimelineItem(item: ArchcarProjectionItem): boolean {
  // Strict allowlist (GTK parity): only known text + inline-event classes render;
  // anything else is ditched rather than shown as a raw event.
  if (!isRenderableClass(item.render_class)) return false;
  if (TEXT_FINALIZED_ONLY.has(item.render_class)) {
    return item.stream_state === "complete";
  }
  return true;
}
