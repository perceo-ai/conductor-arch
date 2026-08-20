import type { CharRange } from "@/lib/htmlRuns";

// Word-level diff for a removed/added line pair, the intra-line highlight every
// mainstream diff viewer shows on top of the row tint. Tokenise both sides,
// take the longest common subsequence of tokens, and report the character
// ranges that fall outside it.

export interface WordDiff {
  removed: CharRange[];
  added: CharRange[];
}

/** Above this token count the O(n*m) table stops being worth the paint. */
const MAX_TOKENS = 400;

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(line: string): Token[] {
  const out: Token[] = [];
  const re = /\w+|\s+|[^\w\s]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Longest common subsequence over tokens, as index pairs into a and b. */
function lcsPairs(a: Token[], b: Token[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i:] and b[j:]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i].text === b[j].text
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** Collapse the tokens not present in `keep` into merged character ranges. */
function rangesOutside(tokens: Token[], keep: Set<number>): CharRange[] {
  const out: CharRange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (keep.has(i)) continue;
    const last = out[out.length - 1];
    if (last && last.end === tokens[i].start) last.end = tokens[i].end;
    else out.push({ start: tokens[i].start, end: tokens[i].end });
  }
  return out;
}

function coversAll(ranges: CharRange[], length: number): boolean {
  return ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === length;
}

/**
 * Character ranges that differ between a removed line and its added
 * counterpart. Returns null when there is nothing useful to draw: identical
 * lines, lines with no token in common (the row tint already says "this line
 * changed"), or lines long enough that the comparison would cost more than it
 * is worth.
 */
export function diffWords(oldLine: string, newLine: string): WordDiff | null {
  if (oldLine === newLine) return null;
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;

  const pairs = lcsPairs(a, b);
  const removed = rangesOutside(a, new Set(pairs.map(([i]) => i)));
  const added = rangesOutside(b, new Set(pairs.map(([, j]) => j)));
  if (!removed.length && !added.length) return null;
  if (coversAll(removed, oldLine.length) && coversAll(added, newLine.length)) return null;
  return { removed, added };
}

/**
 * Which removed rows to compare against which added rows inside one
 * removed-then-added run. Only equal-length runs pair up: one line swapped for
 * one line (or n for n) is unambiguous, while 1-for-3 has no honest pairing and
 * a guess would highlight the wrong words.
 */
export function pairChangedRuns(removedCount: number, addedCount: number): Array<[number, number]> {
  if (!removedCount || !addedCount || removedCount !== addedCount) return [];
  return Array.from({ length: removedCount }, (_, i): [number, number] => [i, i]);
}
