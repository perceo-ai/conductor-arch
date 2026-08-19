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
