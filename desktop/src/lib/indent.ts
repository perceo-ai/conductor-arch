// Pure text-editing helper for Tab / Shift+Tab in a code textarea. Given the
// current text and selection, returns the new text and selection after
// indenting (or dedenting) every line the selection touches. Two-space indent.
// Kept pure (no DOM) so it is unit-testable; the editor wraps it to update the
// textarea and mirror the selection back.

const UNIT = "  "; // two spaces

export interface IndentResult {
  text: string;
  selStart: number;
  selEnd: number;
}

export function applyIndent(
  text: string,
  selStart: number,
  selEnd: number,
  dedent: boolean,
): IndentResult {
  // Collapsed selection + indent: just insert a unit at the caret.
  if (selStart === selEnd && !dedent) {
    const next = text.slice(0, selStart) + UNIT + text.slice(selStart);
    const pos = selStart + UNIT.length;
    return { text: next, selStart: pos, selEnd: pos };
  }

  // Otherwise operate on whole lines spanning the selection.
  const lineStart = text.lastIndexOf("\n", selStart - 1) + 1;
  // The block ends at the line containing selEnd (exclusive of a trailing
  // newline that would pull in the next line).
  let blockEnd = text.indexOf("\n", selEnd);
  if (blockEnd === -1) blockEnd = text.length;
  const before = text.slice(0, lineStart);
  const block = text.slice(lineStart, blockEnd);
  const after = text.slice(blockEnd);

  const lines = block.split("\n");
  let firstDelta = 0;
  let totalDelta = 0;
  const out = lines.map((line, i) => {
    if (dedent) {
      let remove = 0;
      while (remove < UNIT.length && line[remove] === " ") remove++;
      if (remove === 0 && line[0] === "\t") remove = 1; // tolerate a literal tab
      if (i === 0) firstDelta = -remove;
      totalDelta -= remove;
      return line.slice(remove);
    }
    if (i === 0) firstDelta = UNIT.length;
    totalDelta += UNIT.length;
    return UNIT + line;
  });

  const nextText = before + out.join("\n") + after;
  const newStart = Math.max(lineStart, selStart + firstDelta);
  const newEnd = Math.max(newStart, selEnd + totalDelta);
  return { text: nextText, selStart: newStart, selEnd: newEnd };
}
