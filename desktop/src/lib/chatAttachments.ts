export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export interface InlineFileMention {
  start: number;
  end: number;
  query: string;
}

/**
 * The `@query` being typed at the cursor, if there is one.
 *
 * Takes a flat string and a character offset rather than reading the input,
 * which is what lets the composer keep using it now that the input is a
 * `contenteditable` with chips in it: `caretOffset` produces the offset and
 * chips count as the width of the token they stand for.
 */
export function inlineFileMentionAt(value: string, cursor: number): InlineFileMention | null {
  const before = value.slice(0, cursor);
  const match = /(^|\s)@([^\s{}]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: cursor - query.length - 1, end: cursor, query };
}
