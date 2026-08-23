import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal } from "solid-js";
import {
  actions,
  prefsStore,
} from "@/store";
import { send } from "@/bridge/client";
import type {
  WorkspaceChangeScope,
} from "@/bridge/protocol";
import { commitScopeSha } from "@/bridge/protocol";
import { shortSha } from "@/lib/commitLog";
import { DiffView } from "../WorkspaceChanges";
import Diff from "@/components/Diff";
import Icon from "@/components/Icon";
import { renderMarkdownDocument } from "@/lib/markdown";
import { highlightCode, langFromPath } from "@/lib/highlight";
import { editorGutter } from "@/lib/editorGutter";
import { previewKind } from "@/lib/filePreview";
import { applyIndent } from "@/lib/indent";
import { parseKeybindingOverrides, resolveShortcut } from "@/lib/shortcuts";

// File and commit viewers shown in the chat surface's content stack when a
// file tab is active instead of the timeline.
// File view — modes backed by real RPCs:
//   diff    : the unified diff for the file (get_workspace_diff)
//   edit    : the file's UTF-8 text (read_workspace_file), editable + savable
//             (write_workspace_file). Binary/oversize files surface the backend
//             error instead of an editor.
//   preview : rendered output for formats that have one (markdown today), so
//             the raw source and the finished document are both reachable.
//             Offered only when previewKind() recognises the path.
function FileEditor(props: { workspace: string; path: string }) {
  const [loaded] = createResource(
    () => [props.workspace, props.path] as const,
    async ([ws, path]) => {
      try {
        const res = await send({ type: "read_workspace_file", workspace: ws, path });
        if (res.type === "workspace_file_content") return { content: res.content, error: null };
        if (res.type === "error") return { content: "", error: res.message };
        return { content: "", error: "Unexpected response" };
      } catch (err) {
        return { content: "", error: (err as Error).message };
      }
    },
  );
  const [draft, setDraft] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal("");
  // Reset the local draft whenever a fresh file load arrives.
  createEffect(() => {
    const l = loaded();
    if (l && !l.error) setDraft(l.content);
  });
  const dirty = () => {
    const l = loaded();
    return l != null && draft() != null && draft() !== l.content;
  };

  async function save() {
    const text = draft();
    if (text == null) return;
    setStatus("Saving…");
    try {
      const res = await send({
        type: "write_workspace_file",
        workspace: props.workspace,
        path: props.path,
        content: text
      });
      setStatus(res.type === "workspace_file_written" ? "Saved" : "Save failed");
    } catch (err) {
      setStatus(`Save failed: ${(err as Error).message}`);
    }
  }

  // Syntax highlighting overlay: a transparent textarea sits over a highlighted
  // <pre>, with a line-number gutter pinned left of both. All three share
  // identical font metrics + padding so the caret lines up; the textarea drives
  // the scroll and mirrors it onto the other layers. A trailing newline keeps
  // the last visual line height correct.
  const lang = createMemo(() => langFromPath(props.path));
  const highlighted = createMemo(() => {
    const text = draft() ?? "";
    return highlightCode(text.endsWith("\n") ? text : text + "\n", lang());
  });
  const [caret, setCaret] = createSignal(0);
  const gutter = createMemo(() => editorGutter(draft() ?? "", caret()));
  let highlightRef: HTMLPreElement | undefined;
  let gutterRef: HTMLDivElement | undefined;

  function syncScroll(el: HTMLTextAreaElement) {
    if (highlightRef) {
      highlightRef.scrollTop = el.scrollTop;
      highlightRef.scrollLeft = el.scrollLeft;
    }
    if (gutterRef) gutterRef.scrollTop = el.scrollTop;
  }

  function indentSelection(el: HTMLTextAreaElement, dedent: boolean) {
    const res = applyIndent(el.value, el.selectionStart, el.selectionEnd, dedent);
    if (res.text === el.value) return;
    setDraft(res.text);
    // draft() now equals res.text, so the controlled value stays; restore the
    // selection on the next microtask once the DOM has settled.
    queueMicrotask(() => {
      el.selectionStart = res.selStart;
      el.selectionEnd = res.selEnd;
    });
  }

  return (
    <Show
      when={!loaded()?.error}
      fallback={<div class="empty-state">{loaded()?.error}</div>}
    >
      <div class="ws-file-editor">
        <div
          class="ws-file-editor-scroll"
          style={{ "--editor-gutter-w": `${gutter().digits}ch` }}
        >
          <div class="ws-file-editor-gutter" aria-hidden="true" ref={gutterRef}>
            <For each={Array.from({ length: gutter().count }, (_, i) => i + 1)}>
              {(n) => (
                <div classList={{ "ws-file-editor-gutter-line-active": n === gutter().activeLine }}>
                  {n}
                </div>
              )}
            </For>
          </div>
          <pre class="ws-file-editor-highlight hljs" aria-hidden="true" ref={highlightRef}>
            <code innerHTML={highlighted()} />
          </pre>
          <textarea
            class="ws-file-editor-area"
            spellcheck={false}
            value={draft() ?? ""}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              setCaret(e.currentTarget.selectionStart);
              setStatus("");
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onClick={(e) => setCaret(e.currentTarget.selectionStart)}
            onScroll={(e) => syncScroll(e.currentTarget)}
            onKeyDown={(e) => {
              if (resolveShortcut(e, parseKeybindingOverrides(prefsStore.state.keybindings)) === "save") {
                e.preventDefault();
                void save();
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                indentSelection(e.currentTarget, e.shiftKey);
                setStatus("");
              }
            }}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          />
        </div>
        <div class="ws-file-editor-footer">
          <span class="card-meta">
            {status() || (dirty() ? "Unsaved changes" : lang() ?? "plain text")}
          </span>
          <button class="suggested-action" disabled={!dirty()} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </Show>
  );
}

// File-scoped review comments shown beneath the diff — conductor's "comments
// point at changed lines" model. Lists this file's local review comments (by
// line) and lets you add one (line optional) via add_review_comment.
function FileComments(props: { workspace: string; path: string }) {
  const [comments, { refetch }] = createResource(
    () => [props.workspace, props.path] as const,
    async ([ws, path]) => {
      try {
        const res = await send({ type: "list_review_comments", workspace: ws });
        return res.type === "review_comments"
          ? res.comments.filter((c) => c.file_path === path)
          : [];
      } catch {
        return [];
      }
    },
  );
  const [line, setLine] = createSignal("");
  const [body, setBody] = createSignal("");
  async function add() {
    if (!body().trim()) return;
    const lineNum = line().trim() ? Number(line().trim()) : undefined;
    try {
      await actions.addReviewComment({
        workspace: props.workspace,
        filePath: props.path,
        lineNumber: Number.isInteger(lineNum) ? lineNum : undefined,
        body: body().trim()
      });
      setLine("");
      setBody("");
      await refetch();
    } catch {
      // non-fatal
    }
  }
  return (
    <div class="ws-file-comments">
      <div class="detail-label">Review comments</div>
      <For each={comments() ?? []}>
        {(c) => (
          <div class="ws-file-comment-row">
            <span class="ws-file-comment-loc">{c.line_number != null ? `L${c.line_number}` : "file"}</span>
            <span class="ws-file-comment-body">{c.body}</span>
            <span class="ws-file-comment-status">[{c.status}]</span>
          </div>
        )}
      </For>
      <div class="action-row">
        <input
          class="ws-text-input"
          style={{ "max-width": "70px" }}
          placeholder="line"
          value={line()}
          onInput={(e) => setLine(e.currentTarget.value)}
        />
        <input
          class="ws-text-input"
          placeholder="Add a comment on this file…"
          value={body()}
          onInput={(e) => setBody(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <button class="secondary-action" onClick={() => void add()}>Add</button>
      </div>
    </div>
  );
}

// Rendered markdown for the Preview mode. Uses the same renderer as chat
// messages, which escapes raw HTML tokens and highlights fenced code through
// the shared code tokens — so a fence here matches the editor exactly.
function FilePreview(props: { workspace: string; path: string }) {
  const [loaded] = createResource(
    () => [props.workspace, props.path] as const,
    async ([workspace, path]) => {
      try {
        const res = await send({ type: "read_workspace_file", workspace, path });
        if (res.type === "workspace_file_content") return { content: res.content, error: null };
        if (res.type === "error") return { content: "", error: res.message };
        return { content: "", error: "Unexpected response" };
      } catch (err) {
        return { content: "", error: (err as Error).message };
      }
    },
  );
  return (
    <Show
      when={!loaded()?.error}
      fallback={<div class="empty-state">{loaded()?.error}</div>}
    >
      <div class="ws-file-preview">
        <div class="markdown-body" innerHTML={renderMarkdownDocument(loaded()?.content ?? "")} />
      </div>
    </Show>
  );
}

function scopeLabel(scope: WorkspaceChangeScope): string {
  const sha = commitScopeSha(scope);
  if (sha) return `commit ${shortSha(sha)}`;
  return scope === "all" ? "all changes" : "uncommitted";
}

export function FileView(props: { workspace: string; path: string; scope?: WorkspaceChangeScope }) {
  const [mode, setMode] = createSignal<"diff" | "edit" | "preview">("diff");
  const preview = createMemo(() => previewKind(props.path));
  const scope = createMemo<WorkspaceChangeScope>(() => props.scope ?? "all");
  // A previewable file can be swapped for one that isn't while the tab stays
  // open; fall back rather than render an empty pane.
  const active = createMemo(() => (mode() === "preview" && !preview() ? "diff" : mode()));
  return (
    <div class="ws-file-view">
      <div class="ws-file-view-header">
        <span class="ws-file-view-path">{props.path}</span>
        <Show when={active() === "diff"}>
          <span class="ws-file-view-scope">{scopeLabel(scope())}</span>
        </Show>
        <div class="command-center-strip ws-file-view-modes">
          <button
            class="nav-button"
            classList={{ "nav-button-active": active() === "diff" }}
            onClick={() => setMode("diff")}
          >
            Diff
          </button>
          <button
            class="nav-button"
            classList={{ "nav-button-active": active() === "edit" }}
            onClick={() => setMode("edit")}
          >
            Edit
          </button>
          <Show when={preview()}>
            <button
              class="nav-button"
              classList={{ "nav-button-active": active() === "preview" }}
              onClick={() => setMode("preview")}
            >
              Preview
            </button>
          </Show>
        </div>
      </div>
      <Switch>
        <Match when={active() === "edit"}>
          <FileEditor workspace={props.workspace} path={props.path} />
        </Match>
        <Match when={active() === "preview"}>
          <FilePreview workspace={props.workspace} path={props.path} />
        </Match>
        <Match when={active() === "diff"}>
          <DiffView workspace={props.workspace} path={props.path} scope={scope()} />
          <FileComments workspace={props.workspace} path={props.path} />
        </Match>
      </Switch>
    </div>
  );
}

// Commit view — a single commit's stat+patch (git show), rendered with the same
// Diff component as file diffs.
export function CommitView(props: { workspace: string; commit: string; onClose: () => void }) {
  const [diff] = createResource(
    () => [props.workspace, props.commit] as const,
    async ([ws, commit]) => {
      try {
        const res = await send({ type: "get_commit_diff", workspace: ws, commit });
        return res.type === "commit_diff" ? res.diff : "";
      } catch {
        return "";
      }
    },
  );
  return (
    <div class="ws-file-view">
      <div class="ws-file-view-header">
        <span class="ws-file-view-path">Commit {props.commit}</span>
        <button class="ui-button-icon" title="Close" onClick={props.onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div class="ws-diff-view">
        <Show when={!diff.loading} fallback={<div class="empty-state">Loading…</div>}>
          <Show when={(diff() ?? "").trim()} fallback={<div class="empty-state">No diff</div>}>
            <Diff text={diff()!} />
          </Show>
        </Show>
      </div>
    </div>
  );
}

