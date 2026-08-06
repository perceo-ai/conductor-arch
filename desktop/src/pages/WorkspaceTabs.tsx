import { For, Show, createResource, createSignal } from "solid-js";
import { send } from "@/bridge/client";
import { actions } from "@/store";
import type {
  ArchcarChecksSummary,
  ArchcarConfiguredCheck,
  ArchcarTimelineEvent,
  ArchcarWorkspaceConflict,
  Checkpoint,
  ReviewComment,
  Todo,
} from "@/bridge/protocol";

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

  async function remove(id: number) {
    try {
      await actions.deleteCheckpoint(props.workspace, id);
      setFeedback(`Deleted checkpoint #${id}`);
      await refetch();
    } catch (err) {
      setFeedback(`Delete checkpoint failed: ${(err as Error).message}`);
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
              <button class="ui-button-destructive" onClick={() => void remove(c.id)}>
                Delete
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
  const [text, { refetch }] = createResource(
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
  const [log, { refetch: refetchLog }] = createResource(
    () => props.workspace,
    async (ws): Promise<string> => {
      try {
        const res = await send({ type: "get_run_log", workspace: ws });
        return res.type === "run_log" ? res.log : "";
      } catch {
        return "";
      }
    },
  );
  const [feedback, setFeedback] = createSignal("");

  async function runScript() {
    setFeedback("Starting run…");
    try {
      const res = await send({ type: "run_workspace_script", workspace: props.workspace });
      setFeedback(res.type === "run_script_started" ? `Run started (pid ${res.pid})` : "Run failed");
      await Promise.all([refetch(), refetchLog()]);
    } catch (err) {
      setFeedback(`Run failed: ${(err as Error).message}`);
    }
  }
  async function stopScript() {
    setFeedback("Stopping run…");
    try {
      const res = await send({ type: "stop_workspace_script", workspace: props.workspace });
      setFeedback(res.type === "run_script_stopped" ? `Run stopped (pid ${res.pid})` : "Stop failed");
      await refetch();
    } catch (err) {
      setFeedback(`Stop failed: ${(err as Error).message}`);
    }
  }

  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Runtime</div>
      <div class="action-row">
        <button class="suggested-action" onClick={() => void runScript()}>
          Run
        </button>
        <button class="ui-button-destructive" onClick={() => void stopScript()}>
          Stop
        </button>
        <button class="secondary-action" onClick={() => void refetchLog()}>
          Refresh log
        </button>
      </div>
      <Show when={feedback()}><div class="card-meta">{feedback()}</div></Show>
      <div class="detail-label">Processes</div>
      <Show when={!text.loading} fallback={<div class="empty-state">Loading…</div>}>
        <pre class="ws-run-prompt">{text() || "No processes"}</pre>
      </Show>
      <div class="detail-label">Latest run log</div>
      <pre class="ws-run-prompt">{log.loading ? "Loading…" : log() || "No run log yet."}</pre>
    </div>
  );
}

// ---- Timeline (workspace lifecycle history) -------------------------------

export function TimelinePanel(props: { workspace: string }) {
  const [events] = createResource(
    () => props.workspace,
    async (ws): Promise<ArchcarTimelineEvent[]> => {
      try {
        const res = await send({ type: "list_workspace_timeline", workspace: ws });
        return res.type === "workspace_timeline" ? res.events : [];
      } catch {
        return [];
      }
    },
  );
  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Timeline</div>
      <Show
        when={(events() ?? []).length > 0}
        fallback={<div class="empty-state">{events.loading ? "Loading…" : "No events yet"}</div>}
      >
        <For each={[...(events() ?? [])].reverse()}>
          {(e) => (
            <div class="detail-row">
              <span class="detail-label">{e.created_at} · {e.kind}</span>
              <span class="detail-value">{e.summary}</span>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// ---- Checks (DB-only summary) ---------------------------------------------

export function ChecksPanel(props: { workspace: string }) {
  const [summary, { refetch }] = createResource(
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
  const [checks] = createResource(
    () => props.workspace,
    async (ws): Promise<ArchcarConfiguredCheck[]> => {
      try {
        const res = await send({ type: "list_workspace_checks", workspace: ws });
        return res.type === "workspace_checks" ? res.checks : [];
      } catch {
        return [];
      }
    },
  );
  const [checkLog, { refetch: refetchCheckLog }] = createResource(
    () => props.workspace,
    async (ws): Promise<string> => {
      try {
        const res = await send({ type: "get_check_log", workspace: ws });
        return res.type === "check_log" ? res.log : "";
      } catch {
        return "";
      }
    },
  );
  const [feedback, setFeedback] = createSignal("");
  async function runCheck(check: ArchcarConfiguredCheck) {
    setFeedback(`Running ${check.label}…`);
    try {
      const res = await send({
        type: "run_workspace_check",
        workspace: props.workspace,
        key: check.key,
      });
      setFeedback(
        res.type === "check_started"
          ? `${check.label} started (pid ${res.pid})`
          : `${check.label} failed`,
      );
      // Give the check a moment to produce output, then pull its log.
      setTimeout(() => void refetchCheckLog(), 600);
    } catch (err) {
      setFeedback(`${check.label} failed: ${(err as Error).message}`);
    }
  }
  const [conflicts] = createResource(
    () => props.workspace,
    async (ws): Promise<ArchcarWorkspaceConflict[]> => {
      try {
        const res = await send({ type: "list_workspace_conflicts", workspace: ws });
        return res.type === "workspace_conflicts" ? res.conflicts : [];
      } catch {
        return [];
      }
    },
  );
  const run = (label: string, fn: () => Promise<void>) => async () => {
    setFeedback(`${label}…`);
    try {
      await fn();
      setFeedback(`${label} ok`);
      await refetch();
    } catch (err) {
      setFeedback(`${label} failed: ${(err as Error).message}`);
    }
  };

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

  // Locally-computed merge-readiness blockers (conductor's "last review pass
  // before merge"). Uses the DB-only summary — no network.
  const blockers = (s: ArchcarChecksSummary): string[] => {
    const out: string[] = [];
    if (s.open_todos > 0) out.push(`${s.open_todos} open todo${s.open_todos === 1 ? "" : "s"}`);
    if (s.open_review_comments > 0)
      out.push(
        `${s.open_review_comments} open review comment${s.open_review_comments === 1 ? "" : "s"}`,
      );
    if ((s.check_status ?? "").toLowerCase().includes("fail")) out.push("checks failing");
    if (s.conflicting_workspaces > 0)
      out.push(
        `${s.conflicting_workspaces} conflicting workspace${s.conflicting_workspaces === 1 ? "" : "s"}`,
      );
    if ((s.branch_behind ?? 0) > 0) out.push(`${s.branch_behind} behind base`);
    return out;
  };

  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Checks</div>
      <Show when={summary()}>
        {(s) => (
          <div
            class="ws-readiness"
            classList={{ "ws-readiness-blocked": blockers(s()).length > 0 }}
          >
            <Show
              when={blockers(s()).length === 0}
              fallback={<span>Blockers before merge: {blockers(s()).join(", ")}</span>}
            >
              <span>Ready to merge ✓</span>
            </Show>
          </div>
        )}
      </Show>
      <div class="action-row">
        <button class="secondary-action" onClick={run("Push branch", () => actions.pushBranch(props.workspace))}>
          Push branch
        </button>
        <button class="secondary-action" onClick={run("Force push", () => actions.pushBranch(props.workspace, true))}>
          Force push
        </button>
        <button class="secondary-action" onClick={run("Refresh PR", () => actions.refreshPullRequest(props.workspace))}>
          Refresh PR
        </button>
        <button class="suggested-action" onClick={run("Merge PR", () => actions.mergePullRequest(props.workspace))}>
          Merge PR
        </button>
      </div>
      <Show when={feedback()}><div class="card-meta">{feedback()}</div></Show>
      <Show when={(checks() ?? []).length > 0}>
        <div class="detail-label">Local checks</div>
        <For each={checks()}>
          {(check) => (
            <div class="action-row">
              <span class="detail-value" style={{ flex: "1 1 auto" }} title={check.command}>
                {check.label}
              </span>
              <button class="secondary-action" onClick={() => void runCheck(check)}>
                Run
              </button>
            </div>
          )}
        </For>
        <div class="action-row">
          <span class="detail-label" style={{ flex: "1 1 auto" }}>Latest check log</span>
          <button class="secondary-action" onClick={() => void refetchCheckLog()}>
            Refresh log
          </button>
        </div>
        <pre class="ws-run-prompt">
          {checkLog.loading ? "Loading…" : checkLog() || "No check run yet."}
        </pre>
      </Show>
      <Show when={(conflicts() ?? []).length > 0}>
        <div class="detail-label">Conflicting workspaces</div>
        <For each={conflicts()}>
          {(c) => (
            <div class="detail-row">
              <span class="detail-label">{c.workspace}</span>
              <span class="detail-value">{c.files.join(", ")}</span>
            </div>
          )}
        </For>
      </Show>
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
  const [comments, { refetch }] = createResource(
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
  const [file, setFile] = createSignal("");
  const [line, setLine] = createSignal("");
  const [body, setBody] = createSignal("");
  const [feedback, setFeedback] = createSignal("");

  async function add() {
    if (!file().trim() || !body().trim()) {
      setFeedback("File path and comment body are required.");
      return;
    }
    const lineNum = line().trim() ? Number(line().trim()) : undefined;
    try {
      await actions.addReviewComment({
        workspace: props.workspace,
        filePath: file().trim(),
        lineNumber: Number.isInteger(lineNum) ? lineNum : undefined,
        body: body().trim(),
      });
      setFile("");
      setLine("");
      setBody("");
      setFeedback("");
      await refetch();
    } catch (err) {
      setFeedback(`Add review comment failed: ${(err as Error).message}`);
    }
  }

  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Review comments</div>
      <div class="action-row">
        <input class="ws-text-input" placeholder="file path" value={file()} onInput={(e) => setFile(e.currentTarget.value)} />
        <input class="ws-text-input" style={{ "max-width": "80px" }} placeholder="line" value={line()} onInput={(e) => setLine(e.currentTarget.value)} />
      </div>
      <div class="action-row">
        <input class="ws-text-input" placeholder="comment…" value={body()} onInput={(e) => setBody(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
        <button class="suggested-action" onClick={() => void add()}>Add</button>
      </div>
      <Show when={feedback()}><div class="card-meta">{feedback()}</div></Show>
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
              <Show when={c.github_thread_id}>
                {(tid) => (
                  <button
                    class="secondary-action"
                    onClick={() =>
                      void actions
                        .resolveReviewThread(props.workspace, tid(), c.status !== "resolved")
                        .then(refetch)
                        .catch((err) => setFeedback(`Resolve failed: ${(err as Error).message}`))
                    }
                  >
                    {c.status === "resolved" ? "Reopen" : "Resolve"}
                  </button>
                )}
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
