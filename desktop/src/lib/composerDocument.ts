import { fileNameFromPath } from "./chatAttachments";

/**
 * The composer's document is a flat list: the input has no block structure, so
 * a tree would be a nesting level nothing ever reads.
 *
 * Two serializations leave this module and both are load-bearing. `toVisible`
 * is what gets stored and what `TimelineItem` re-renders out of history;
 * `toInput` is what the agent receives. Both are byte-identical to the strings
 * the composer produced before chips existed, which is what keeps this change
 * contained to the composer — the daemon and the transcript see nothing.
 */
export type ComposerNode =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; label: string }
  | { kind: "command"; name: string };

/**
 * The same marker grammar `renderMarkdownWithInlineFileChips` matches on, so a
 * message renders as the same chips in the composer and in the timeline. The
 * extension list is what makes `{not a file}` stay literal text.
 */
const FILE_MARKER =
  /\{([A-Za-z0-9_.@+ -]+\.(?:c|cc|cpp|css|gif|go|h|hpp|html|jpeg|jpg|js|jsx|json|md|pdf|png|py|rs|scss|sh|sql|toml|ts|tsx|txt|webp|ya?ml))\}/g;

/**
 * The visible token a node stands for. Caret arithmetic measures chips with
 * this, so it has to agree with `toVisible` exactly or the mention parsers see
 * a cursor that is off by the width of every chip to its left.
 */
export function nodeText(node: ComposerNode): string {
  switch (node.kind) {
    case "text":
      return node.text;
    case "file":
      return `{${node.label}}`;
    case "command":
      return `/${node.name}`;
  }
}

export function toVisible(nodes: ComposerNode[]): string {
  return nodes.map(nodeText).join("");
}

export function toInput(nodes: ComposerNode[]): string {
  return nodes.map((node) => (node.kind === "file" ? `@${node.path}` : nodeText(node))).join("");
}

/**
 * Parse the visible form back into nodes, for draft restore and for text seeded
 * from elsewhere in the app.
 *
 * A marker carries the file's name and not the path it was picked from, so a
 * restored chip's `path` is its label. That is exactly what the pre-chip
 * composer sent for a marker whose attachment entry had been dropped, so
 * nothing that used to survive a round trip stops surviving one.
 */
export function fromVisible(text: string): ComposerNode[] {
  const nodes: ComposerNode[] = [];
  let last = 0;
  for (const match of text.matchAll(FILE_MARKER)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push({ kind: "text", text: text.slice(last, start) });
    const label = match[1];
    nodes.push({ kind: "file", path: label, label });
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push({ kind: "text", text: text.slice(last) });
  return nodes;
}

/**
 * Drop empty text nodes and merge adjacent ones, so a document has exactly one
 * spelling. Editing leaves both behind constantly — deleting the last character
 * of a run empties its text node rather than removing it — and without this,
 * two documents that render identically compare as different.
 */
export function normalize(nodes: ComposerNode[]): ComposerNode[] {
  const out: ComposerNode[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      if (node.text === "") continue;
      const prev = out.at(-1);
      if (prev?.kind === "text") {
        out[out.length - 1] = { kind: "text", text: prev.text + node.text };
        continue;
      }
    }
    out.push(node);
  }
  return out;
}

/** Marks a chip element. Also the hook the CSS and the tests select on. */
export const CHIP_ATTR = "data-chip";

function chipNode(el: Element): ComposerNode | null {
  const kind = el.getAttribute(CHIP_ATTR);
  if (kind === "file") {
    const path = el.getAttribute("data-path") ?? "";
    return { kind: "file", path, label: el.getAttribute("data-label") ?? fileNameFromPath(path) };
  }
  if (kind === "command") return { kind: "command", name: el.getAttribute("data-name") ?? "" };
  return null;
}

/** The visible width of a whole subtree, measured the way `nodeText` measures. */
function widthOf(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").length;
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  const el = node as Element;
  if (el.tagName === "BR") return 1;
  const chip = chipNode(el);
  if (chip) return nodeText(chip).length;
  let total = 0;
  for (const child of el.childNodes) total += widthOf(child);
  return total;
}

/**
 * Read the live DOM back into nodes.
 *
 * The user's typing is applied by the browser, not by us — repainting the
 * document on every keystroke is what makes `contenteditable` inputs jump the
 * caret — so between repaints the DOM is the source of truth and this is how
 * the signal catches up with it. Elements the browser invented on its own (a
 * `<div>` wrapping a pasted line, say) contribute their text and are dropped:
 * the document stays flat no matter what the engine does.
 */
export function nodesFromDom(root: Node): ComposerNode[] {
  const out: ComposerNode[] = [];
  const visit = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.push({ kind: "text", text: child.textContent ?? "" });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      if (el.tagName === "BR") {
        out.push({ kind: "text", text: "\n" });
        continue;
      }
      const chip = chipNode(el);
      if (chip) {
        out.push(chip);
        continue;
      }
      visit(el);
    }
  };
  visit(root);
  return normalize(out);
}

/**
 * Index into `toVisible(nodesFromDom(root))` for a DOM selection point.
 *
 * This is the whole reason `inlineFileMentionAt` and `skillMentionAt` survive
 * the rewrite untouched: they take `(value, cursor)` against a flat string, and
 * this produces the cursor. A chip counts as the width of the token it stands
 * for, so `@`-detection sees the same text the user would have typed.
 */
export function caretOffset(root: Node, container: Node, offset: number): number {
  let total = 0;
  let found = false;

  const walk = (node: Node) => {
    if (found) return;
    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) {
        total += offset;
      } else {
        // On an element the offset counts child nodes, not characters.
        for (let i = 0; i < offset && i < node.childNodes.length; i += 1) {
          total += widthOf(node.childNodes[i]);
        }
      }
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      total += (node.textContent ?? "").length;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.tagName === "BR") {
      total += 1;
      return;
    }
    if (chipNode(el)) {
      total += widthOf(el);
      return;
    }
    for (const child of el.childNodes) {
      walk(child);
      if (found) return;
    }
  };

  walk(root);
  return total;
}
