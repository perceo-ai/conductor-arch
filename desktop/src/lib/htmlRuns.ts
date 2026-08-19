import { escapeHtml } from "@/lib/highlight";

// highlight.js hands back HTML, not tokens, so there is no way to wrap a
// character range (a word-level diff span) around part of it without first
// taking the markup apart. These helpers flatten hljs output into a list of
// runs — a slice of source text plus the stack of span classes covering it —
// and re-emit that list with extra wrappers spliced in. Splitting at run
// boundaries is what lets a diff-word span cross a syntax span without
// producing mismatched tags.

export interface HtmlRun {
  /** Decoded source text, so offsets line up with the original line. */
  text: string;
  /** Class attributes of the enclosing spans, outermost first. */
  classes: string[];
}

export interface CharRange {
  start: number;
  end: number;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#\d+|#[xX][0-9a-fA-F]+|\w+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/** Flatten highlight.js output into text runs tagged with their span classes. */
export function parseHighlightedHtml(html: string): HtmlRun[] {
  const runs: HtmlRun[] = [];
  const stack: string[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (!buf) return;
    runs.push({ text: decodeEntities(buf), classes: [...stack] });
    buf = "";
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      buf += html.slice(i);
      break;
    }
    buf += html.slice(i, lt);
    const gt = html.indexOf(">", lt);
    if (gt < 0) {
      // Unterminated tag: treat the remainder as text rather than dropping it.
      buf += html.slice(lt);
      break;
    }
    const tag = html.slice(lt + 1, gt);
    flush();
    if (tag.startsWith("/")) {
      stack.pop();
    } else if (!tag.endsWith("/")) {
      const cls = /class="([^"]*)"/.exec(tag);
      stack.push(cls ? cls[1] : "");
    }
    i = gt + 1;
  }
  flush();
  return runs;
}

function wrap(classes: string[], inner: string): string {
  let out = inner;
  for (let i = classes.length - 1; i >= 0; i--) {
    out = classes[i] ? `<span class="${classes[i]}">${out}</span>` : `<span>${out}</span>`;
  }
  return out;
}

/**
 * Re-emit highlighted HTML with `className` wrapped around each character
 * range. Ranges are offsets into the decoded source text; they may span
 * several syntax spans, in which case the wrapper is split per run.
 */
export function applyRanges(html: string, ranges: CharRange[], className: string): string {
  const runs = parseHighlightedHtml(html);
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;

  for (const run of runs) {
    const start = pos;
    const end = pos + run.text.length;
    pos = end;

    let inner = "";
    let cur = start;
    for (const range of sorted) {
      if (range.end <= start || range.start >= end) continue;
      const s = Math.max(range.start, start);
      const e = Math.min(range.end, end);
      if (s > cur) inner += escapeHtml(run.text.slice(cur - start, s - start));
      inner += `<span class="${className}">${escapeHtml(run.text.slice(s - start, e - start))}</span>`;
      cur = e;
    }
    if (cur < end) inner += escapeHtml(run.text.slice(cur - start));
    out += wrap(run.classes, inner);
  }
  return out;
}
