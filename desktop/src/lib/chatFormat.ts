import type { ArchcarProjectionItem } from "@/bridge/protocol";

// GTK chat-surface parity: which projected render classes we actually render and
// how. Ports session_surface.rs's provider_projection_item_widget dispatch — the
// timeline is a strict allowlist, everything else is dropped rather than shown as
// a raw blob.

// Prose rendered as markdown (chat_text_markup in GTK).
export const TEXT_CLASSES = new Set(["user_chat", "assistant_chat", "reasoning_card"]);

// Inline "chip-card" event classes → the fallback verb when the title carries no
// action word. Commands "Ran", tools "Used", file reads "Read", diffs "Edited".
// Any class not listed here (and not a text class) is ditched.
const DEFAULT_VERB: Record<string, string> = {
  command_card: "Ran",
  process_card: "Ran",
  background_card: "Ran",
  file_card: "Read",
  diff_card: "Edited",
  skill_card: "Used",
  tool_card: "Used",
  plugin_card: "Used",
  subagent_card: "Used",
  nested_transcript_card: "Used",
};

// GTK's action-label prefixes: when the projected title already starts with one
// of these verbs, we keep it as the action and use the rest as the chip so we
// don't double up (e.g. "Ran ls" → verb "Ran", chip "ls").
const ACTION_PREFIXES = new Set([
  "Ran",
  "Read",
  "Used",
  "Opened",
  "Added",
  "Edited",
  "Deleted",
  "Searched",
]);

export function isInlineEventClass(renderClass: string): boolean {
  return renderClass in DEFAULT_VERB;
}

/** True if we render this item at all — a strict allowlist (text or inline event). */
export function isRenderableClass(renderClass: string): boolean {
  return TEXT_CLASSES.has(renderClass) || isInlineEventClass(renderClass);
}

/**
 * Split an inline event into its action verb and content chip, mirroring GTK's
 * inline_event_action_label: if the title leads with a known verb, that's the
 * action and the remainder is the chip; otherwise fall back to a per-class verb
 * (tools → "Used", commands → "Ran", …) with the whole title as the chip.
 */
export function inlineEventVerbChip(renderClass: string, title: string): { verb: string; chip: string } {
  const trimmed = title.trim();
  const space = trimmed.indexOf(" ");
  const first = space === -1 ? trimmed : trimmed.slice(0, space);
  if (ACTION_PREFIXES.has(first)) {
    return { verb: first, chip: trimmed.slice(space + 1).trim() };
  }
  return { verb: DEFAULT_VERB[renderClass] ?? "Used", chip: trimmed };
}

// Archductor-internal blocks injected into prompts/responses that must not be
// shown to the user (port of core's strip_archductor_metadata_block +
// hidden-instruction/attachment stripping, applied at render time).
const BLOCK_TAGS = ["archductor_metadata", "archductor_hidden_instruction"];

export function stripArchductorMetadata(text: string): string {
  let out = text;
  for (const tag of BLOCK_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  }
  // Self-closing attachment references (<archductor_attachment ... />).
  out = out.replace(/<archductor_attachment\b[^>]*\/>/g, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function isDiffCard(item: ArchcarProjectionItem): boolean {
  return item.render_class === "diff_card";
}

export function isTerminalCard(item: ArchcarProjectionItem): boolean {
  return (
    item.render_class === "command_card" ||
    item.render_class === "process_card" ||
    item.render_class === "background_card"
  );
}
