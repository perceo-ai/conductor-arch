// Line-number gutter model for the workspace file editor. Kept pure so the
// counting and caret-to-line mapping are unit-testable without a DOM.

export interface GutterModel {
  /** Total lines in the buffer. */
  count: number;
  /** Gutter width in digits. */
  digits: number;
  /** 1-based line holding the caret, for the current-line highlight. */
  activeLine: number;
}

/** Match the diff gutter's floor so the two surfaces line up visually. */
const MIN_DIGITS = 2;

export function editorGutter(text: string, caret: number): GutterModel {
  const count = text.split("\n").length;
  const clamped = Math.max(0, Math.min(caret, text.length));
  let activeLine = 1;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === "\n") activeLine++;
  }
  return {
    count,
    digits: Math.max(MIN_DIGITS, String(count).length),
    activeLine: Math.min(activeLine, count),
  };
}
