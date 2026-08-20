export interface ComposerAttachment {
  path: string;
  label: string;
  marker: string;
}

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function attachmentMarker(path: string): string {
  return `{${fileNameFromPath(path)}}`;
}

export interface InlineFileMention {
  start: number;
  end: number;
  query: string;
}

export function inlineFileMentionAt(value: string, cursor: number): InlineFileMention | null {
  const before = value.slice(0, cursor);
  const match = /(^|\s)@([^\s{}]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: cursor - query.length - 1, end: cursor, query };
}

export function insertInlineAttachmentMarker(
  value: string,
  marker: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; cursor: number } {
  const needsLeadingSpace = selectionStart > 0 && !/\s/.test(value.charAt(selectionStart - 1));
  const needsTrailingSpace = selectionEnd < value.length && !/\s/.test(value.charAt(selectionEnd));
  const insert = `${needsLeadingSpace ? " " : ""}${marker}${needsTrailingSpace ? " " : ""}`;
  const next = value.slice(0, selectionStart) + insert + value.slice(selectionEnd);
  return { value: next, cursor: selectionStart + insert.length };
}

export function promptTextWithAttachmentRefs(
  value: string,
  attachments: ComposerAttachment[],
): string {
  let next = value;
  for (const attachment of attachments) {
    next = next.replaceAll(attachment.marker, `@${attachment.path}`);
  }
  return next;
}

export function removeAdjacentAttachmentMarker(
  value: string,
  cursor: number,
  direction: "backward" | "forward",
): { value: string; cursor: number } | null {
  const markerPattern = /\{[^{}\s][^{}]*?\}/g;
  for (const match of value.matchAll(markerPattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const atBackwardEdge = direction === "backward" && cursor === end;
    const atForwardEdge = direction === "forward" && cursor === start;
    if (!atBackwardEdge && !atForwardEdge) continue;
    const before = value.slice(0, start).replace(/[ \t]+$/, "");
    const after = value.slice(end).replace(/^[ \t]+/, "");
    const separator = before.length > 0 && after.length > 0 ? " " : "";
    return {
      value: before + separator + after,
      cursor: before.length,
    };
  }
  return null;
}
