import { For, createMemo } from "solid-js";
import { highlightLine, escapeHtml, langFromPath } from "@/lib/highlight";

// Unified-diff renderer with a +/- gutter and syntax-highlighted code. Works for
// single-file and multi-file diffs: file headers (`+++ b/path`) switch the
// active language so each file's hunks highlight correctly. `defaultLang` seeds
// the language when a bare (headerless) diff is passed, e.g. a single file's
// diff fetched with a known path.

type Kind = "added" | "removed" | "hunk" | "meta" | "context";

interface Row {
  kind: Kind;
  html: string; // highlighted inner HTML for the code text
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

export default function Diff(props: { text: string; defaultLang?: string }) {
  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    let lang = props.defaultLang;
    const lines = props.text.replace(/\n$/, "").split("\n");
    for (const line of lines) {
      const kind = classify(line);
      if (kind === "meta") {
        // Track the target file to pick the language for following hunks.
        if (line.startsWith("+++ ")) {
          const p = line.slice(4).replace(/^b\//, "").trim();
          if (p && p !== "/dev/null") lang = langFromPath(p) ?? lang;
        }
        out.push({ kind, html: escapeHtml(line) });
        continue;
      }
      if (kind === "hunk") {
        out.push({ kind, html: escapeHtml(line) });
        continue;
      }
      const code = kind === "added" || kind === "removed" ? line.slice(1) : line;
      out.push({ kind, html: highlightLine(code, lang) });
    }
    return out;
  });

  return (
    <div class="chat-inline-event-code chat-inline-event-code-rows hljs">
      <For each={rows()}>
        {(row) => (
          <div
            class="chat-inline-event-code-row"
            classList={{
              "chat-inline-event-code-row-added": row.kind === "added",
              "chat-inline-event-code-row-removed": row.kind === "removed",
              "chat-inline-event-code-row-hunk": row.kind === "hunk",
              "chat-inline-event-code-row-meta": row.kind === "meta",
              "chat-inline-event-code-row-context": row.kind === "context",
            }}
          >
            <span class="chat-inline-event-code-sign">
              {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : ""}
            </span>
            <span class="chat-inline-event-code-text" innerHTML={row.html} />
          </div>
        )}
      </For>
    </div>
  );
}
