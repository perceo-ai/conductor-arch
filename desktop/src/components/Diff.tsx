import { For, createMemo } from "solid-js";
import { computeDiffRows, type DiffRow } from "@/lib/diff";

// Unified-diff renderer with old/new line-number gutters, a +/- sign column,
// and syntax-highlighted code. Row computation (incl. line numbering) lives in
// the pure, unit-tested @/lib/diff module; this component only renders.

export default function Diff(props: { text: string; defaultLang?: string }) {
  const rows = createMemo<DiffRow[]>(() => computeDiffRows(props.text, props.defaultLang));

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
            <span class="diff-lineno diff-lineno-old">{row.oldNo ?? ""}</span>
            <span class="diff-lineno diff-lineno-new">{row.newNo ?? ""}</span>
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
