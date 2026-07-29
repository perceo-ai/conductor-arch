import { For, Show, createResource, createSignal } from "solid-js";
import { send } from "@/bridge/client";
import type { ArchcarChecksSummary, Checkpoint, ReviewComment, Todo } from "@/bridge/protocol";

// Read-only workspace command-center tabs — ports of workspace_todos_panel,
// workspace_checkpoint_panel, workspace_processes_text, workspace_review_panel
// (DB-backed, no network). Each fetches on demand via createResource; the
// mutating actions (add todo, create/restore checkpoint) refetch on success.

// ---- Todos ----------------------------------------------------------------

export function TodosPanel(props: { workspace: string }) {
  const [todos, { refetch }] = createResource(
    () => props.workspace,
    async (ws): Promise<Todo[]> => {
      try {
        const res = await send({ type: "list_todos", workspace: ws });
        return res.type === "todos" ? res.todos : [];
      } catch {
        return [];
      }
    },
  );
  const [text, setText] = createSignal("");

  async function add() {
    const value = text().trim();
    if (!value) return;
    setText("");
    try {
      await send({ type: "add_todo", workspace: props.workspace, text: value });
      await refetch();
    } catch {
      setText(value);
    }
  }

  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Todos</div>
      <Show
        when={(todos() ?? []).length > 0}
        fallback={<div class="empty-state">{todos.loading ? "Loading…" : "No todos"}</div>}
      >
        <For each={todos()}>
          {(t) => (
            <div class="detail-row">
              <span class="detail-label">#{t.id} {t.status}</span>
              <span class="detail-value">{t.text}</span>
            </div>
          )}
        </For>
      </Show>
      <div class="action-row">
        <input
          class="ws-text-input"
          placeholder="Add todo..."
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <button class="suggested-action" onClick={() => void add()}>
          Add Todo
        </button>
      </div>
    </div>
  );
}

// ---- Checkpoints ----------------------------------------------------------

export function CheckpointsPanel(props: { workspace: string }) {
  const [checkpoints, { refetch }] = createResource(
    () => props.workspace,
    async (ws): Promise<Checkpoint[]> => {
      try {
        const res = await send({ type: "list_checkpoints", workspace: ws });
        return res.type === "checkpoints" ? res.checkpoints : [];
      } catch {
        return [];
      }
    },
  );
  const [message, setMessage] = createSignal("");
  const [feedback, setFeedback] = createSignal("");

  async function create() {
    const value = message().trim();
    if (!value) {
      setFeedback("Checkpoint message required.");
      return;
    }
    setMessage("");
    try {
      const res = await send({ type: "create_checkpoint", workspace: props.workspace, message: value });
      setFeedback(res.type === "checkpoint_saved" ? `Created checkpoint #${res.checkpoint.id}` : "");
      await refetch();
    } catch (err) {
      setFeedback(`Create checkpoint failed: ${(err as Error).message}`);
    }
  }

  async function restore(id: number) {
    try {
      const res = await send({ type: "restore_checkpoint", workspace: props.workspace, checkpoint_id: id });
      setFeedback(res.type === "checkpoint_saved" ? `Restored checkpoint #${res.checkpoint.id}` : "");
      await refetch();
    } catch (err) {
      setFeedback(`Restore checkpoint failed: ${(err as Error).message}`);
    }
  }

  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Checkpoints</div>
      <div class="action-row">
        <input
          class="ws-text-input"
          placeholder="Checkpoint message"
          value={message()}
          onInput={(e) => setMessage(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
        />
        <button class="suggested-action" onClick={() => void create()}>
          Create
        </button>
      </div>
      <Show when={feedback()}>
        <div class="card-meta">{feedback()}</div>
      </Show>
      <Show
        when={(checkpoints() ?? []).length > 0}
        fallback={
          <div class="empty-state">{checkpoints.loading ? "Loading…" : "No checkpoints yet."}</div>
        }
      >
        <For each={checkpoints()}>
          {(c) => (
            <div class="action-row">
              <span class="detail-value" style={{ flex: "1 1 auto" }}>
                #{c.id} {c.created_at} - {c.message}
              </span>
              <button class="secondary-action" onClick={() => void restore(c.id)}>
                Restore
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// ---- Processes (text blob) ------------------------------------------------

export function ProcessesPanel(props: { workspace: string }) {
  const [text] = createResource(
    () => props.workspace,
    async (ws): Promise<string> => {
      try {
        const res = await send({ type: "get_workspace_processes", workspace: ws });
        return res.type === "workspace_processes" ? res.text : "";
      } catch {
        return "";
      }
    },
  );
  return (
    <div class="ws-diff-view">
      <Show when={!text.loading} fallback={<div class="empty-state">Loading…</div>}>
        <pre class="ws-diff-text">{text()}</pre>
      </Show>
    </div>
  );
}

// ---- Checks (DB-only summary) ---------------------------------------------

export function ChecksPanel(props: { workspace: string }) {
  const [summary] = createResource(
    () => props.workspace,
    async (ws): Promise<ArchcarChecksSummary | null> => {
      try {
        const res = await send({ type: "get_checks_summary", workspace: ws });
        return res.type === "checks_summary" ? res.summary : null;
      } catch {
        return null;
      }
    },
  );

  const rows = (s: ArchcarChecksSummary): [string, string][] => [
    ["Changed files", String(s.changed_files)],
    ["Run", s.run_status ?? "—"],
    ["Checks", s.check_status ?? "—"],
    ["Session", `${s.session_status ?? "—"} (${s.active_sessions} active)`],
    ["Todos", `${s.open_todos} open / ${s.total_todos} total`],
    ["Open review comments", String(s.open_review_comments)],
    [
      "Pull request",
      s.pull_request_number != null
        ? `#${s.pull_request_number} ${s.pull_request_state ?? ""}`.trim()
        : "No PR",
    ],
    [
      "Branch",
      s.branch_ahead != null
        ? `${s.branch_ahead} ahead / ${s.branch_behind ?? 0} behind`
        : "—",
    ],
    ["Source branch ahead", String(s.source_branch_ahead)],
    ["Conflicting workspaces", String(s.conflicting_workspaces)],
  ];

  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Checks</div>
      <Show
        when={summary()}
        fallback={<div class="empty-state">{summary.loading ? "Loading…" : "No summary"}</div>}
      >
        {(s) => (
          <For each={rows(s())}>
            {([label, value]) => (
              <div class="detail-row">
                <span class="detail-label">{label}</span>
                <span class="detail-value">{value}</span>
              </div>
            )}
          </For>
        )}
      </Show>
    </div>
  );
}

// ---- Review (local comments) ----------------------------------------------

export function ReviewPanel(props: { workspace: string }) {
  const [comments] = createResource(
    () => props.workspace,
    async (ws): Promise<ReviewComment[]> => {
      try {
        const res = await send({ type: "list_review_comments", workspace: ws });
        return res.type === "review_comments" ? res.comments : [];
      } catch {
        return [];
      }
    },
  );
  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Review comments</div>
      <Show
        when={(comments() ?? []).length > 0}
        fallback={<div class="empty-state">{comments.loading ? "Loading…" : "No review comments"}</div>}
      >
        <For each={comments()}>
          {(c) => (
            <div class="detail-row">
              <span class="detail-label">
                {c.file_path}
                {c.line_number != null ? `:${c.line_number}` : ""} [{c.status}]
              </span>
              <span class="detail-value">{c.body}</span>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
