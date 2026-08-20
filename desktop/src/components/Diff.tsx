import { For, Show, createMemo, createSignal } from "solid-js";
import Icon from "@/components/Icon";
import { parseUnifiedDiff, type DiffFile, type DiffHunk } from "@/lib/diff";

// Unified-diff renderer following the conventions of GitHub and the editors'
// built-in diff views: one collapsible block per file with a path header and
// change counts, collapsible hunks, a pinned old/new line-number gutter, and
// word-level highlighting inside changed lines. Parsing, numbering, and word
// diffing all live in the pure @/lib/diff module; this component only renders.

function Hunk(props: { hunk: DiffHunk }) {
  const [open, setOpen] = createSignal(true);
  return (
    <>
      <button
        class="diff-hunk-header"
        aria-expanded={open()}
        title={open() ? "Collapse hunk" : "Expand hunk"}
        onClick={() => setOpen(!open())}
      >
        {/* The header spans the full scroll width so its tint reaches the end
            of the longest line; the label itself stays pinned to the left edge
            so the collapse affordance survives horizontal scrolling. */}
        <span class="diff-hunk-inner">
          <Icon name={open() ? "chevron-down" : "chevron-right"} class="diff-chevron" />
          <span class="diff-hunk-range">{props.hunk.header}</span>
          <Show when={props.hunk.section}>
            <span class="diff-hunk-section">{props.hunk.section}</span>
          </Show>
        </span>
      </button>
      <Show when={open()}>
        <For each={props.hunk.rows}>
          {(row) => (
            <div
              class="diff-row"
              classList={{
                "diff-row-added": row.kind === "added",
                "diff-row-removed": row.kind === "removed",
                "diff-row-context": row.kind === "context",
              }}
            >
              {/* Numbers and signs are drawn with CSS content: attr(), which
                  keeps them out of the selection so copying a diff yields
                  code and nothing else. */}
              <span class="diff-gutter diff-gutter-old" data-n={row.oldNo ?? ""} />
              <span class="diff-gutter diff-gutter-new" data-n={row.newNo ?? ""} />
              <span
                class="diff-sign"
                data-n={row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
              />
              <span class="diff-code" innerHTML={row.html} />
            </div>
          )}
        </For>
      </Show>
    </>
  );
}

function FileBlock(props: { file: DiffFile }) {
  const [open, setOpen] = createSignal(true);
  return (
    <div
      class="diff-file"
      // Gutter columns size to the widest line number in this file, so a
      // four-digit file doesn't clip and a short one doesn't waste space.
      style={{ "--diff-gutter-w": `${props.file.gutterDigits}ch` }}
    >
      <button
        class="diff-file-header"
        aria-expanded={open()}
        title={open() ? "Collapse file" : "Expand file"}
        onClick={() => setOpen(!open())}
      >
        <Icon name={open() ? "chevron-down" : "chevron-right"} class="diff-chevron" />
        <Icon name="file-code" class="diff-file-icon" />
        <span class="diff-file-path">
          <Show when={props.file.oldPath}>
            <span class="diff-file-oldpath">{props.file.oldPath}</span>
            <span class="diff-file-arrow">→</span>
          </Show>
          {props.file.path || "diff"}
        </span>
        <Show when={props.file.status !== "modified"}>
          <span class={`diff-file-status diff-file-status-${props.file.status}`}>
            {props.file.status}
          </span>
        </Show>
        <Show when={props.file.status !== "binary"}>
          <span class="diff-file-counts">
            <span class="diff-file-add">+{props.file.additions}</span>
            <span class="diff-file-del">-{props.file.deletions}</span>
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="diff-file-body">
          <Show
            when={props.file.hunks.length}
            fallback={<div class="diff-file-empty">No textual diff</div>}
          >
            {/* Sized to the longest line so every row shares one width and the
                row tints run the full scroll extent, not just the viewport. */}
            <div class="diff-file-rows">
              <For each={props.file.hunks}>{(hunk) => <Hunk hunk={hunk} />}</For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export default function Diff(props: { text: string; defaultLang?: string }) {
  const doc = createMemo(() => parseUnifiedDiff(props.text, props.defaultLang));

  return (
    <div class="diff">
      <Show when={doc().preamble.length}>
        <div class="diff-preamble">
          <For each={doc().preamble}>{(line) => <span class="diff-preamble-line">{line}</span>}</For>
        </div>
      </Show>
      <Show when={doc().files.length} fallback={<div class="diff-note">No changes.</div>}>
        <For each={doc().files}>{(file) => <FileBlock file={file} />}</For>
      </Show>
      <Show when={doc().notes.length}>
        <div class="diff-note">
          <For each={doc().notes}>{(line) => <div>{line}</div>}</For>
        </div>
      </Show>
    </div>
  );
}
