/** Whether a chat as a whole is still working, and when it stops.
 *
 * `chatGenerationState` answers for the main agent only. A chat is not done
 * just because the main agent's turn ended: a background subagent can still be
 * running, and the main agent will pick its result up when it lands. A chat
 * that dings while a subagent is mid-flight trains the operator to ignore the
 * ding, so "finished" here means: the main agent is idle AND no subagent is
 * running.
 */

import type { ArchcarProjectionItem } from "@/bridge/protocol";
import { chatGenerationState, type ChatGenerationInput } from "./chatGeneration";

/** Timeline cards the daemon projects for subagent work (provider_projection.rs). */
const SUBAGENT_RENDER_CLASSES = new Set(["subagent_card", "nested_transcript_card"]);

type BusyItem = Pick<ArchcarProjectionItem, "render_class" | "status" | "parent_id">;

/** Subagent cards the daemon still reports as running. */
export function activeSubagentCount(projection: readonly BusyItem[]): number {
  let n = 0;
  for (const item of projection) {
    if (item.status !== "running" || !SUBAGENT_RENDER_CLASSES.has(item.render_class)) continue;
    // A `subagent_card` nested under an Agent card is the prompt the subagent
    // was given. The daemon projects it from a user record that has no
    // completion, so it reads "running" for the life of the chat; counting it
    // would mean a chat that ever used a subagent never finishes.
    if (item.render_class === "subagent_card" && item.parent_id) continue;
    n += 1;
  }
  return n;
}

export interface ChatBusyInput extends ChatGenerationInput {
  projection: readonly BusyItem[];
}

/** The main agent is streaming, tool-calling or starting, or any subagent is active. */
export function isChatGenerating(input: ChatBusyInput): boolean {
  if (chatGenerationState(input) !== "idle") return true;
  // Subagents only count while their session is alive. A card the provider
  // never closed would otherwise keep a dead chat "busy" forever, and the
  // operator would never hear it finish.
  if (input.session == null) return false;
  return activeSubagentCount(input.projection) > 0;
}

/**
 * Per-chat falling-edge detector: `observe` returns true exactly once per
 * busy → idle transition. The first observation of a chat only records a
 * baseline, so opening the app, reconnecting, or re-reading an already idle
 * chat never fires; repeated idle observations after the edge never fire again.
 */
export function createGenerationEdgeDetector() {
  const last = new Map<number, boolean>();
  return {
    observe(threadId: number, generating: boolean): boolean {
      const was = last.get(threadId);
      last.set(threadId, generating);
      return was === true && !generating;
    },
    forget(threadId: number) {
      last.delete(threadId);
    },
  };
}
