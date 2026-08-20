import { highlightLine, langFromPath } from "@/lib/highlight";
import { applyRanges } from "@/lib/htmlRuns";
import { diffWords, pairChangedRuns } from "@/lib/wordDiff";

// Unified diff → structured document (no JSX), so parsing, line numbering, and
// word-level highlighting are all unit-testable.
//
// Input is a plain unified diff. Some producers wrap it in prose: `git show`
// leads with a commit header and a --stat block, and the server appends a
// truncation notice to an oversized diff. Prose before the first file becomes
// the preamble and prose after it becomes notes, so neither is mistaken for
// code.

export type RowKind = "added" | "removed" | "context";
export type FileStatus = "added" | "deleted" | "renamed" | "modified" | "binary";

export interface DiffRow {
  kind: RowKind;
  /** Raw source text with the +/- sign stripped. */
  text: string;
  /** Highlighted inner HTML, including any word-level diff spans. */
  html: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@` marker on its own. */
  header: string;
  /** Context git appends after the marker — usually the enclosing function. */
  section: string;
  rows: DiffRow[];
}

export interface DiffFile {
  path: string;
  /** Previous path, set only when the file was renamed. */
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Width the line-number gutter needs, in digits. */
  gutterDigits: number;
  hunks: DiffHunk[];
}

export interface DiffDocument {
  /** Prose before the first file: a `git show` commit header and --stat block. */
  preamble: string[];
  files: DiffFile[];
  /** Prose after the last file, e.g. the server's truncation notice. */
  notes: string[];
}

/** Never shrink the gutter below this, so narrow files don't look ragged. */
const MIN_GUTTER_DIGITS = 2;

function stripPathPrefix(raw: string): string {
  const p = raw.trim().replace(/^"(.*)"$/, "$1");
  return p.replace(/^[ab]\//, "");
}

/** Split `diff --git a/old b/new` into its two paths. */
function parseGitHeader(line: string): { oldPath: string; path: string } | null {
  const rest = line.slice("diff --git ".length).trim();
  const sep = rest.lastIndexOf(" b/");
  if (sep < 0) return null;
  return {
    oldPath: stripPathPrefix(rest.slice(0, sep)),
    path: stripPathPrefix(rest.slice(sep + 1)),
  };
}

/** Split `@@ -a,b +c,d @@ trailing` into counters, marker, and trailing text. */
function parseHunkHeader(line: string): { oldNo: number; newNo: number; header: string; section: string } | null {
  const m = /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@)(.*)$/.exec(line);
  if (!m) return null;
  return { header: m[1], oldNo: Number(m[2]), newNo: Number(m[3]), section: m[4].trim() };
}

/**
 * Word-level highlight for each removed/added pair inside a hunk. Runs of
 * removed rows followed by added rows are the replacement candidates; anything
 * pairChangedRuns declines to match keeps the plain row tint.
 */
function applyWordDiff(rows: DiffRow[]): void {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "removed") {
      i++;
      continue;
    }
    let removedEnd = i;
    while (removedEnd < rows.length && rows[removedEnd].kind === "removed") removedEnd++;
    let addedEnd = removedEnd;
    while (addedEnd < rows.length && rows[addedEnd].kind === "added") addedEnd++;

    const removed = rows.slice(i, removedEnd);
    const added = rows.slice(removedEnd, addedEnd);
    for (const [ri, ai] of pairChangedRuns(removed.length, added.length)) {
      const words = diffWords(removed[ri].text, added[ai].text);
      if (!words) continue;
      removed[ri].html = applyRanges(removed[ri].html, words.removed, "diff-word");
      added[ai].html = applyRanges(added[ai].html, words.added, "diff-word");
    }
    i = Math.max(addedEnd, removedEnd);
  }
}

function finalizeFile(file: DiffFile): void {
  let additions = 0;
  let deletions = 0;
  let maxLine = 0;
  for (const hunk of file.hunks) {
    for (const row of hunk.rows) {
      if (row.kind === "added") additions++;
      else if (row.kind === "removed") deletions++;
      maxLine = Math.max(maxLine, row.oldNo ?? 0, row.newNo ?? 0);
    }
    applyWordDiff(hunk.rows);
  }
  file.additions = additions;
  file.deletions = deletions;
  file.gutterDigits = Math.max(MIN_GUTTER_DIGITS, String(maxLine).length);
  if (file.oldPath === file.path) file.oldPath = null;
}

export function parseUnifiedDiff(text: string, defaultLang?: string): DiffDocument {
  const doc: DiffDocument = { preamble: [], files: [], notes: [] };
  const lines = text.replace(/\n$/, "").split("\n");

  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let lang = defaultLang;
  let oldNo = 0;
  let newNo = 0;

  const openFile = (): DiffFile => {
    const next: DiffFile = {
      path: "",
      oldPath: null,
      status: "modified",
      additions: 0,
      deletions: 0,
      gutterDigits: MIN_GUTTER_DIGITS,
      hunks: [],
    };
    doc.files.push(next);
    hunk = null;
    return next;
  };
  const setPath = (target: DiffFile, path: string) => {
    target.path = path;
    lang = langFromPath(path) ?? defaultLang;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      const paths = parseGitHeader(line);
      file = openFile();
      if (paths) {
        file.oldPath = paths.oldPath;
        setPath(file, paths.path);
      }
      continue;
    }

    if (hunk === null && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      const current: DiffFile = file ?? openFile();
      file = current;
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current.status = line.startsWith("--- ") ? "added" : "deleted";
      } else if (line.startsWith("+++ ") || !current.path) {
        setPath(current, stripPathPrefix(target));
      }
      continue;
    }

    const parsed = parseHunkHeader(line);
    if (parsed) {
      const current: DiffFile = file ?? openFile();
      file = current;
      oldNo = parsed.oldNo;
      newNo = parsed.newNo;
      hunk = { header: parsed.header, section: parsed.section, rows: [] };
      current.hunks.push(hunk);
      continue;
    }

    if (hunk) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      // git prefixes every body line, writing an empty context line as a lone
      // space. A bare empty line is therefore the gap before the next section,
      // not content — consuming it here would append a phantom row.
      const sign = line[0];
      if (sign === " " || sign === "+" || sign === "-") {
        const code = line.slice(1);
        const kind: RowKind = sign === "+" ? "added" : sign === "-" ? "removed" : "context";
        const html = highlightLine(code, lang);
        if (kind === "added") hunk.rows.push({ kind, text: code, html, oldNo: null, newNo: newNo++ });
        else if (kind === "removed")
          hunk.rows.push({ kind, text: code, html, oldNo: oldNo++, newNo: null });
        else hunk.rows.push({ kind, text: code, html, oldNo: oldNo++, newNo: newNo++ });
        continue;
      }
    }

    // File-level metadata git prints between the header and the first hunk.
    if (file && !hunk) {
      if (line.startsWith("new file mode")) {
        file.status = "added";
        continue;
      }
      if (line.startsWith("deleted file mode")) {
        file.status = "deleted";
        continue;
      }
      if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = stripPathPrefix(line.slice("rename from ".length));
        continue;
      }
      if (line.startsWith("rename to ")) {
        file.status = "renamed";
        setPath(file, stripPathPrefix(line.slice("rename to ".length)));
        continue;
      }
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        file.status = "binary";
        continue;
      }
      if (
        line.startsWith("index ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("similarity index ") ||
        line.startsWith("dissimilarity index ") ||
        line.startsWith("copy from ") ||
        line.startsWith("copy to ")
      ) {
        continue;
      }
    }

    // Anything left is prose wrapped around the diff.
    file = null;
    hunk = null;
    const prose = line.trim();
    if (!prose) continue;
    // Trimmed because git indents --stat rows and the commit subject, which
    // would otherwise render as ragged leading whitespace in the meta bar.
    if (doc.files.length) doc.notes.push(prose);
    else doc.preamble.push(prose);
  }

  for (const f of doc.files) finalizeFile(f);
  return doc;
}
