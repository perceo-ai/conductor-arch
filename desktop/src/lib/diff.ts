import { highlightLine, escapeHtml, langFromPath } from "@/lib/highlight";

// Pure unified-diff → rows conversion (no JSX) so line numbering is
// unit-testable. Tracks old/new line counters across `@@` hunk headers and
// switches the highlight language on `+++ b/path` headers for multi-file diffs.

type Kind = "added" | "removed" | "hunk" | "meta" | "context";

export interface DiffRow {
  kind: Kind;
  html: string; // highlighted inner HTML for the code text
  oldNo: number | null; // old-file line number (removed/context)
  newNo: number | null; // new-file line number (added/context)
}

function classify(line: string): Kind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ") ||
    line.startsWith("\\ No newline")
  )
    return "meta";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

// Parse `@@ -oldStart,oldCount +newStart,newCount @@` → [oldStart, newStart].
function parseHunk(line: string): [number, number] | null {
  const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

export function computeDiffRows(text: string, defaultLang?: string): DiffRow[] {
  const out: DiffRow[] = [];
  let lang = defaultLang;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.replace(/\n$/, "").split("\n");
  for (const line of lines) {
    const kind = classify(line);
    if (kind === "meta") {
      if (line.startsWith("+++ ")) {
        const p = line.slice(4).replace(/^b\//, "").trim();
        if (p && p !== "/dev/null") lang = langFromPath(p) ?? lang;
      }
      out.push({ kind, html: escapeHtml(line), oldNo: null, newNo: null });
      continue;
    }
    if (kind === "hunk") {
      const parsed = parseHunk(line);
      if (parsed) {
        oldNo = parsed[0];
        newNo = parsed[1];
      }
      out.push({ kind, html: escapeHtml(line), oldNo: null, newNo: null });
      continue;
    }
    const code = kind === "added" || kind === "removed" ? line.slice(1) : line;
    const html = highlightLine(code, lang);
    if (kind === "added") {
      out.push({ kind, html, oldNo: null, newNo: newNo++ });
    } else if (kind === "removed") {
      out.push({ kind, html, oldNo: oldNo++, newNo: null });
    } else {
      out.push({ kind, html, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}
