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
