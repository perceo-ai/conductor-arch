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
  // A task the agent moved to the background: its title is what it is doing.
  background_card: "Background",
  error_card: "Error",
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
  "Asked",
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

/**
 * True for a row that is something a subagent did (a command, a tool call, a
 * nested Agent) rather than something it said, or the prompt it was handed —
 * core titles that row "Asked subagent".
 */
export function isSubagentAction(item: { render_class: string; title: string }): boolean {
  if (!isInlineEventClass(item.render_class)) return false;
  if (item.render_class === "nested_transcript_card") return false;
  return !(item.render_class === "subagent_card" && item.title === "Asked subagent");
}

/** The action count an Agent card shows in its header: "1 action", "12 actions". */
export function formatActionCount(count: number): string {
  return `${count} ${count === 1 ? "action" : "actions"}`;
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
  if (isCommandCard(renderClass)) {
    const command = first === "Ran" ? trimmed.slice(space + 1).trim() : trimmed;
    const readChip = readOnlyCommandChip(command);
    if (readChip) return { verb: "Read", chip: readChip };
  }
  if (ACTION_PREFIXES.has(first)) {
    return { verb: first, chip: trimmed.slice(space + 1).trim() };
  }
  return { verb: DEFAULT_VERB[renderClass] ?? "Used", chip: trimmed };
}

function isCommandCard(renderClass: string): boolean {
  return renderClass === "command_card" || renderClass === "process_card" || renderClass === "background_card";
}

function readOnlyCommandChip(command: string): string | null {
  const inner = unwrapShellCommand(command);
  if (!isReadOnlyCommand(inner)) return null;
  return readableCommandTargets(inner) || firstCommandWord(inner);
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:env\s+[^=\s]+=[^\s]+\s+)*\/?(?:usr\/bin\/|bin\/)?(?:zsh|bash|sh)\s+-(?:l?c|c)\s+(.+)$/);
  if (!match) return trimmed;
  return unquote(match[1].trim());
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) return trimmed;
  return trimmed.slice(1, -1).replace(/\\(["'\\])/g, "$1");
}

function isReadOnlyCommand(command: string): boolean {
  const first = firstCommandWord(command);
  if (!first) return false;
  if (["cat", "find", "head", "ls", "nl", "pwd", "rg", "sed", "tail", "wc"].includes(first)) return true;
  if (first === "git") return /^git\s+(?:diff|grep|log|show|status)(?:\s|$)/.test(command);
  if (first === "gh") return /^gh\s+(?:api|pr\s+(?:checks|view|diff|status)|run\s+(?:list|view)|issue\s+(?:list|view))(?:\s|$)/.test(command);
  return false;
}

function firstCommandWord(command: string): string {
  return command.trim().split(/\s+/, 1)[0]?.split("/").pop() ?? "";
}

function readableCommandTargets(command: string): string {
  const targets = command
    .match(/(?:^|\s)(?:\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./@+-]+|(?:^|\s)[A-Za-z0-9_.@+-]+\.[A-Za-z0-9_+-]+/g)
    ?.map((target) => target.trim().replace(/^['"`]|['"`]$/g, ""))
    .filter((target) => !/^\d+(?:,\d+)?p$/.test(target) && !target.startsWith("http"))
    .map((target) => target.split("/").filter(Boolean).at(-1) ?? target)
    .filter(Boolean);
  if (!targets?.length) return "";
  return [...new Set(targets)].slice(0, 3).join(", ");
}

// Archductor-internal blocks injected into prompts/responses that must not be
// shown to the user (port of core's strip_archductor_metadata_block +
// hidden-instruction/attachment stripping, applied at render time).
const BLOCK_TAGS = [
  "archductor_metadata",
  "archductor_hidden_instruction",
  // Claude wraps a subagent's report in a list of the tools it used. The rows
  // above the report already say what it ran, in more detail and in order.
  "tools-used-before-summary",
];

export function stripArchductorMetadata(text: string): string {
  let out = text;
  for (const tag of BLOCK_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  }
  // Self-closing attachment references (<archductor_attachment ... />).
  out = out.replace(/<archductor_attachment\b[^>]*\/>/g, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function formatReasoningText(text: string): string {
  return stripArchductorMetadata(text)
    .replace(/\*\*([^*\n][^*]*?)\*\*/g, "$1")
    .trim();
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


/**
 * True when a card's nested rows are a subagent's conversation rather than its
 * own output — the card delegated, and what is inside is another agent's work.
 */
export function carriesSubagentWork(
  nested: readonly { render_class: string; title: string }[],
): boolean {
  return nested.some(
    (row) => row.render_class === "subagent_card" || row.render_class === "nested_transcript_card",
  );
}

// How providers title the call that starts a subagent. The prefix is plumbing;
// what follows is the subagent's own description, which is the part worth
// reading.
const DELEGATION_PREFIXES = ["Agent", "Task", "Subagent"];

/**
 * The header for a card that handed work to a subagent. "Used `Agent Count .rs
 * files`" made delegation look like any other tool call in a column of them;
 * this says who is working instead.
 */
export function delegationVerbChip(title: string): { verb: string; chip: string } {
  const trimmed = title.trim();
  const space = trimmed.indexOf(" ");
  const first = space === -1 ? trimmed : trimmed.slice(0, space);
  const chip = DELEGATION_PREFIXES.includes(first) && space !== -1 ? trimmed.slice(space + 1).trim() : trimmed;
  return { verb: "Subagent", chip };
}

/**
 * A subagent's report, without the plumbing Claude wraps it in.
 *
 * What comes back is: a "[Subagent hand-back] …" safety frame explaining that
 * the text is model output, then the report, then an `agentId:` handle for
 * resuming the agent and a `<usage>` block of token counts. Only the middle is
 * the subagent's answer, and the frame is longer than most reports — in the
 * card it buried a one-line result under six lines of boilerplate.
 *
 * The frame is dropped, not trusted: it is removed only as a prefix ending at
 * its own "The report follows:" marker, so a forged frame further down the
 * report cannot cut the text above it.
 */
export function stripSubagentFraming(text: string): string {
  let out = text.replace(/^\s*\[Subagent hand-back][\s\S]*?The report follows:[ \t]*\n?/, "");
  out = out.replace(/^agentId:[^\n]*\n?/m, "");
  out = out.replace(/<usage>[\s\S]*?<\/usage>\s*$/, "");
  return out.replace(/\n{3,}/g, "\n\n").trimEnd();
}
