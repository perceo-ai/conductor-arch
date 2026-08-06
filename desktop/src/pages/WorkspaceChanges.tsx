import { For, Show, createResource, createSignal } from "solid-js";
import { send } from "@/bridge/client";
import type { DiffFileSummary, WorkspaceChangeScope } from "@/bridge/protocol";
import Diff from "@/components/Diff";
import { langFromPath } from "@/lib/highlight";

// Changes views — port of workspace_changes_panel + workspace_diff_sections.
// The right panel shows the summary rows; the main Changes tab shows rows plus
// the three-section unified diff. Both fetch on demand via createResource.

function countsText(f: DiffFileSummary): string {
  return f.additions != null && f.deletions != null ? `+${f.additions} -${f.deletions}` : "binary";
}

function stateLabel(f: DiffFileSummary): string {
  if (f.untracked) return "[untracked]";
  if (f.staged && f.unstaged) return "[staged+unstaged]";
  if (f.staged) return "[staged]";
  if (f.unstaged) return "[unstaged]";
  return "[clean]";
}

function ChangeRow(props: { file: DiffFileSummary; showState: boolean; onOpen?: (path: string) => void }) {
  return (
    <button class="ws-file-summary-row-content" onClick={() => props.onOpen?.(props.file.path)}>
      <span class="ws-file-icon">·</span>
      <span class="ws-file-name">{props.file.path}</span>
      <Show when={props.showState}>
        <span class="ws-file-summary-state">{stateLabel(props.file)}</span>
      </Show>
      <span class="ws-file-summary-counts">{countsText(props.file)}</span>
    </button>
  );
}

export function ChangesRows(props: {
  workspace: string;
  defaultScope?: WorkspaceChangeScope;
  openFile?: (path: string) => void;
}) {
  const [scope, setScope] = createSignal<WorkspaceChangeScope>(props.defaultScope ?? "uncommitted");
  const [changes, { refetch }] = createResource(
    () => [props.workspace, scope()] as const,
    async ([ws, sc]) => {
      try {
        const res = await send({ type: "get_workspace_changes", workspace: ws, scope: sc });
        return res.type === "workspace_changes" ? res.files : [];
      } catch {
        return [];
      }
    },
  );
  const [commits, { refetch: refetchCommits }] = createResource(
    () => props.workspace,
    async (ws): Promise<string> => {
      try {
        const res = await send({ type: "get_recent_commits", workspace: ws, limit: 15 });
        return res.type === "recent_commits" ? res.log : "";
      } catch {
        return "";
      }
    },
  );
  const [commitMsg, setCommitMsg] = createSignal("");
  const [commitFeedback, setCommitFeedback] = createSignal("");
  async function suggestMessage() {
    try {
      const res = await send({ type: "get_commit_message_draft", workspace: props.workspace });
      if (res.type === "commit_message_draft" && res.message.trim()) {
        setCommitMsg(res.message.trim());
        setCommitFeedback("");
      }
    } catch {
      // non-fatal
    }
  }
  async function commit() {
    const message = commitMsg().trim();
    if (!message) {
      setCommitFeedback("Enter a commit message.");
      return;
    }
    setCommitFeedback("Committing…");
    try {
      const res = await send({
        type: "commit_workspace_changes",
        workspace: props.workspace,
        message,
        stage_all: true,
      });
      if (res.type === "workspace_committed") {
        setCommitMsg("");
        setCommitFeedback("Committed.");
        await Promise.all([refetch(), refetchCommits()]);
      } else if (res.type === "error") {
        setCommitFeedback(res.message);
      } else {
        setCommitFeedback("Commit failed.");
      }
    } catch (err) {
      setCommitFeedback(`Commit failed: ${(err as Error).message}`);
    }
  }
  return (
    <div class="ws-file-summary-panel">
      <div class="ws-changes-header">
        <span class="ws-changes-title">Changes</span>
        <div class="ws-changes-scope">
          <button
            class="nav-button"
            classList={{ "nav-button-active": scope() === "uncommitted" }}
            onClick={() => setScope("uncommitted")}
          >
            Uncommitted
          </button>
          <button
            class="nav-button"
            classList={{ "nav-button-active": scope() === "all" }}
            onClick={() => setScope("all")}
          >
            All
          </button>
        </div>
      </div>
      <Show
        when={(changes() ?? []).length > 0}
        fallback={<div class="empty-state">{changes.loading ? "Loading…" : "No changes"}</div>}
      >
        <For each={changes()}>
          {(file) => (
            <ChangeRow file={file} showState={scope() === "uncommitted"} onOpen={props.openFile} />
          )}
        </For>
      </Show>
      <Show when={(changes() ?? []).length > 0}>
        <div class="ws-commit-box">
          <input
            class="ws-text-input"
            placeholder="Commit message…"
            value={commitMsg()}
            onInput={(e) => setCommitMsg(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && void commit()}
          />
          <button class="secondary-action" title="Draft a message from changed files" onClick={() => void suggestMessage()}>
            Suggest
          </button>
          <button class="suggested-action" onClick={() => void commit()}>
            Stage all &amp; commit
          </button>
        </div>
        <Show when={commitFeedback()}><div class="card-meta">{commitFeedback()}</div></Show>
      </Show>
      <Show when={(commits() ?? "").trim()}>
        <div class="ws-commits-section">
          <div class="ws-commits-head">
            <span class="section-title">Recent commits</span>
            <button class="ui-button-icon" title="Refresh" onClick={() => void refetchCommits()}>⟳</button>
          </div>
          <pre class="ws-commits-log">{commits()}</pre>
        </div>
      </Show>
    </div>
  );
}

export function DiffView(props: { workspace: string; path?: string }) {
  const [diff] = createResource(
    () => [props.workspace, props.path] as const,
    async ([ws, path]) => {
      try {
        const res = await send({ type: "get_workspace_diff", workspace: ws, path });
        return res.type === "workspace_diff" ? res.diff : "";
      } catch {
        return "";
      }
    },
  );
  return (
    <div class="ws-diff-view">
      <Show when={!diff.loading} fallback={<div class="empty-state">Loading diff…</div>}>
        <Show when={(diff() ?? "").trim()} fallback={<div class="empty-state">No diff</div>}>
          <Diff text={diff()!} defaultLang={props.path ? langFromPath(props.path) : undefined} />
        </Show>
      </Show>
    </div>
  );
}

export default function ChangesTab(props: { workspace: string }) {
  // The diff below renders all three scopes (working tree / unstaged / staged),
  // so the summary rows default to "all" for a consistent picture. The
  // right-panel ChangesRows keeps its own default independently.
  return (
    <div class="ws-changes-tab">
      <ChangesRows workspace={props.workspace} defaultScope="all" />
      <DiffView workspace={props.workspace} />
    </div>
  );
}
