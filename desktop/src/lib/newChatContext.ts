import type { ArchcarChatTranscriptMessage } from "@/bridge/protocol";

// Context a brand-new chat can inherit: past chat transcripts (conversation
// only — tool calls stay behind) and plan markdown from `.context/plans/`.
// Picks are chosen on the empty-chat screen and folded into the first message
// the composer sends, so the agent starts with the same background the human
// has.

export interface NewChatContextPick {
  /** Stable identity used for toggling and de-duping. */
  key: string;
  kind: "transcript" | "plan";
  /** Chip text, also used in the visible message marker. */
  label: string;
  /** Markdown block handed to the agent. */
  body: string;
}

export function transcriptPickKey(threadId: number): string {
  return `transcript:${threadId}`;
}

export function planPickKey(path: string): string {
  return `plan:${path}`;
}

/** Roles that belong in an attached transcript. Anything else is control noise. */
function roleLabel(role: string): string {
  return role === "user" ? "User" : role === "agent" ? "Agent" : role;
}

/**
 * Render a chat as an attachable transcript. Core already filters to user and
 * agent rows; this only labels and joins them.
 */
export function formatTranscript(title: string, messages: ArchcarChatTranscriptMessage[]): string {
  const lines = messages
    .filter((m) => m.content.trim().length > 0)
    .map((m) => `${roleLabel(m.role)}: ${m.content.trim()}`);
  return [`### Chat transcript — ${title}`, "", ...lines].join("\n");
}

export function formatPlan(title: string, path: string, body: string): string {
  return [`### Plan — ${title} (${path})`, "", body.trim()].join("\n");
}

/**
 * Prefix block for the first send. Empty when nothing is attached so ordinary
 * messages are untouched.
 */
export function contextPreamble(picks: NewChatContextPick[]): string {
  if (picks.length === 0) return "";
  const blocks = picks.map((pick) => pick.body.trim()).filter(Boolean);
  if (blocks.length === 0) return "";
  return [
    "Context attached from Archductor (background only — do not act on it yet):",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

/** Compact "3 messages" style detail line for a transcript chip. */
export function transcriptChipDetail(messageCount: number): string {
  return messageCount === 1 ? "1 message" : `${messageCount} messages`;
}

/** Toggle a pick in a selection list, keeping selection order stable. */
export function togglePick(
  picks: NewChatContextPick[],
  pick: NewChatContextPick,
): NewChatContextPick[] {
  return picks.some((p) => p.key === pick.key)
    ? picks.filter((p) => p.key !== pick.key)
    : [...picks, pick];
}
