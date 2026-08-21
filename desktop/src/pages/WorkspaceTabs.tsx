import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import githubActionsLogo from "material-icon-theme/icons/github-actions-workflow.svg?url";
import { openExternal, send } from "@/bridge/client";
import { actions, nav, threadsStore, toastsStore, workspacesStore } from "@/store";
import Icon from "@/components/Icon";
import { parsePrReadiness, type PrCheckRow, type PrGateTone } from "@/lib/prReadiness";
import type {
  WorkflowRun,
  WorkflowRunSummary,
  ArchcarChatThread,
  ArchcarChecksSummary,
  ArchcarConfiguredCheck,
  ArchcarTimelineEvent,
  Checkpoint,
  SessionKind,
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

  const [compareDiff, setCompareDiff] = createSignal<{ id: number; diff: string } | null>(null);

  async function compare(id: number) {
    // Toggle off when the same checkpoint's diff is already open.
    if (compareDiff()?.id === id) {
      setCompareDiff(null);
      return;
    }
    try {
      const res = await send({ type: "compare_checkpoint", workspace: props.workspace, checkpoint_id: id });
      if (res.type === "checkpoint_diff") {
        const body = res.diff.trim()
          ? res.diff + (res.truncated ? "\n[diff truncated]" : "")
          : "No differences from the working tree.";
        setCompareDiff({ id, diff: body });
        setFeedback("");
      } else if (res.type === "error") {
        setFeedback(res.message);
      }
    } catch (err) {
      setFeedback(`Compare checkpoint failed: ${(err as Error).message}`);
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
            <>
              <div class="action-row">
                <span class="detail-value" style={{ flex: "1 1 auto" }}>
                  #{c.id} {c.created_at} - {c.message}
                </span>
                <button class="secondary-action" onClick={() => void compare(c.id)}>
                  {compareDiff()?.id === c.id ? "Hide diff" : "Compare"}
                </button>
                <button class="secondary-action" onClick={() => void restore(c.id)}>
                  Restore
                </button>
                <button class="ui-button-destructive" onClick={() => void remove(c.id)}>
                  Delete
                </button>
              </div>
              <Show when={compareDiff()?.id === c.id}>
                <pre class="ws-run-prompt">{compareDiff()?.diff}</pre>
              </Show>
            </>
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
  const [spotlight, { refetch: refetchSpotlight }] = createResource(
    () => props.workspace,
    async (ws): Promise<boolean> => {
      try {
        const res = await send({ type: "get_spotlight_status", workspace: ws });
        return res.type === "spotlight_status" ? res.active : false;
      } catch {
        return false;
      }
    },
  );
  const [feedback, setFeedback] = createSignal("");

  async function startSpotlight() {
    setFeedback("Starting spotlight…");
    try {
      const res = await send({ type: "start_spotlight", workspace: props.workspace });
      setFeedback(res.type === "spotlight_status" && res.active ? "Spotlight active" : "");
      if (res.type === "error") setFeedback(res.message);
      await refetchSpotlight();
    } catch (err) {
      setFeedback(`Spotlight failed: ${(err as Error).message}`);
    }
  }
  async function stopSpotlight() {
    try {
      await send({ type: "stop_spotlight", workspace: props.workspace });
      setFeedback("Spotlight stopped");
      await refetchSpotlight();
    } catch (err) {
      setFeedback(`Stop spotlight failed: ${(err as Error).message}`);
    }
  }

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

  async function recoverProcesses() {
    setFeedback("Recovering stale process state...");
    try {
      const res = await send({ type: "recover_workspace_lifecycle_jobs" });
      if (res.type === "workspace_lifecycle_recovery") {
        const total = res.recovered + res.reconciled_processes;
        setFeedback(
          total === 0
            ? "No stale processes found."
            : `Recovered ${res.recovered} lifecycle job${res.recovered === 1 ? "" : "s"} and reconciled ${res.reconciled_processes} stale process record${res.reconciled_processes === 1 ? "" : "s"}.`,
        );
        await Promise.all([refetch(), refetchLog()]);
      } else if (res.type === "error") {
        setFeedback(res.message);
      }
    } catch (err) {
      setFeedback(`Recovery failed: ${(err as Error).message}`);
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
        <button class="secondary-action" onClick={() => void recoverProcesses()}>
          Recover stale processes
        </button>
      </div>
      <div class="action-row">
        <span class="detail-label" style={{ flex: "1 1 auto" }}>
          Spotlight testing: {spotlight() ? "active" : "off"}
        </span>
        <Show
          when={spotlight()}
          fallback={<button class="secondary-action" onClick={() => void startSpotlight()}>Start spotlight</button>}
        >
          <button class="ui-button-destructive" onClick={() => void stopSpotlight()}>Stop spotlight</button>
        </Show>
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
            <div class="detail-row ws-timeline-row">
              <span class="detail-label">{e.created_at} · {e.kind}</span>
              <span class="detail-value">{e.summary}</span>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// ---- Checks (flat PR status) ----------------------------------------------

function statusText(status?: string): string {
  if (!status) return "unknown";
  return status.toLowerCase().replace(/_/g, " ");
}

function reviewStatusLabel(summary: ArchcarChecksSummary | null | undefined, readinessText?: string): string {
  const readiness = readinessText ? parsePrReadiness(readinessText) : null;
  const decision = statusText(readiness?.reviewDecision);
  if (decision && decision !== "unknown") return decision;
  if (summary?.pull_request_number != null) return "Waiting for PR review";
  return "No pull request yet";
}

function reviewStatusTone(summary: ArchcarChecksSummary | null | undefined, readinessText?: string): PrCheckRow["tone"] {
  const label = reviewStatusLabel(summary, readinessText).toLowerCase();
  if (label.includes("approved")) return "passed";
  if (label.includes("change") || label.includes("blocked")) return "failed";
  if (summary?.pull_request_number != null) return "running";
  return "unknown";
}

export function CheckGlyph(props: { tone: PrCheckRow["tone"] }) {
  return (
    <span class={`ws-check-glyph ws-check-glyph-${props.tone}`}>
      {props.tone === "passed" ? "✓" : props.tone === "failed" ? "×" : props.tone === "running" ? "•" : "○"}
    </span>
  );
}

function FlatCheckRow(props: { check: PrCheckRow }) {
  return (
    <div class="ws-check-row-flat">
      <CheckGlyph tone={props.check.tone} />
      <img class="ws-check-provider-icon" src={githubActionsLogo} alt="" aria-hidden="true" />
      <span class="ws-check-name" title={props.check.name}>
        {props.check.name}
      </span>
      <span class="ws-check-status">{statusText(props.check.status)}</span>
      <Show when={props.check.detail}>
        {(url) => (
          <button
            class="ws-check-open"
            title="Open check"
            onClick={() => {
              void openExternal(url());
            }}
          >
            <Icon name="external" />
          </button>
        )}
      </Show>
    </div>
  );
}

function LocalCheckRow(props: { check: ArchcarConfiguredCheck }) {
  return (
    <div class="ws-check-row-flat">
      <CheckGlyph tone="unknown" />
      <span class="ws-check-provider-icon ws-check-provider-local">⌘</span>
      <span class="ws-check-name" title={props.check.command}>
        {props.check.label}
      </span>
      <span class="ws-check-status">local</span>
    </div>
  );
}

function providerKind(provider: string): SessionKind {
  const p = provider.toLowerCase();
  if (p.includes("claude")) return "claude";
  if (p.includes("shell")) return "shell";
  return "codex";
}

async function activeWorkspaceChatThread(workspace: string): Promise<ArchcarChatThread> {
  const loaded = threadsStore.list(workspace);
  let threads = loaded.length > 0 ? loaded : await threadsStore.refresh(workspace);
  threads = threads.filter((thread) => thread.provider !== "shell");
  const selected = nav.selectedChatThread();
  const existing = threads.find((thread) => thread.id === selected) ?? threads[0];
  if (existing) return existing;
  const created = await send({
    type: "create_chat_thread",
    workspace,
    provider: "codex",
    title: "PR review",
  });
  if (created.type !== "chat_thread_created") throw new Error("Unable to create chat thread.");
  await threadsStore.refresh(workspace);
  return created.thread;
}

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
  const [readiness] = createResource(
    () => props.workspace,
    async (ws): Promise<string | null> => {
      try {
        const res = await send({ type: "get_pull_request_readiness", workspace: ws });
        return res.type === "pull_request_readiness" ? res.text : null;
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
  const readinessView = createMemo(() => (readiness() ? parsePrReadiness(readiness()!) : null));
  const prUrl = () => workspacesStore.row(props.workspace)?.prUrl;

  // CI is the other half of "is this branch good": the local checks above say
  // what this machine thinks, these say what GitHub did after the push.
  const [workflowRuns] = createResource(
    () => props.workspace,
    async (ws): Promise<WorkflowRunSummary | null> => {
      try {
        const res = await send({ type: "list_workflow_runs", workspace: ws });
        return res.type === "workflow_runs" ? res.summary : null;
      } catch {
        return null;
      }
    },
  );

  const workflowTone = (run: WorkflowRun): PrGateTone => {
    if (run.conclusion === "success") return "passed";
    if (["failure", "timed_out", "startup_failure", "action_required"].includes(run.conclusion)) {
      return "failed";
    }
    // Queued counts as running: the branch is not settled yet.
    if (run.status !== "completed") return "running";
    // Cancelled and skipped need no action, so they are neither pass nor fail.
    return "unknown";
  };

  return (
    <div class="ws-tab-panel command-panel ws-checks-panel-flat">
      <div class="ws-flat-section-label">Git status</div>
      <div class="ws-git-status-line">
        <CheckGlyph tone={reviewStatusTone(summary(), readiness() ?? undefined)} />
        <span class="ws-check-name">{reviewStatusLabel(summary(), readiness() ?? undefined)}</span>
        <Show when={prUrl()}>
          {(url) => (
            <button
              class="ws-check-open"
              title="Open pull request"
              onClick={() => {
                void openExternal(url());
              }}
            >
              <Icon name="external" />
            </button>
          )}
        </Show>
      </div>
            <div class="ws-flat-section-label">
        <img src={githubActionsLogo} alt="" class="ws-actions-logo" />
        GitHub Actions
      </div>
      <Show
        when={workflowRuns()}
        fallback={<div class="ws-flat-empty">Loading workflow runs…</div>}
      >
        {(summary) => (
          <Show
            when={!summary().unavailable}
            fallback={
              <div class="ws-flat-empty" title={summary().unavailable ?? ""}>
                No GitHub Actions for this branch.
              </div>
            }
          >
            <Show
              when={summary().runs.length > 0}
              fallback={<div class="ws-flat-empty">No runs for this branch yet.</div>}
            >
              <For each={summary().runs.slice(0, 8)}>
                {(run: WorkflowRun) => (
                  <div class="ws-git-status-line">
                    <CheckGlyph tone={workflowTone(run)} />
                    <span class="ws-check-name">{run.name}</span>
                    <span class="ws-check-detail">
                      #{run.number} {run.conclusion || run.status}
                    </span>
                    <button
                      class="ws-check-open"
                      title="Open run on GitHub"
                      onClick={() => void openExternal(run.url)}
                    >
                      <Icon name="external" />
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        )}
      </Show>
<div class="ws-flat-section-label">Checks</div>
      <Show
        when={(readinessView()?.checks.length ?? 0) > 0}
        fallback={
          <Show
            when={(checks() ?? []).length > 0}
            fallback={<div class="ws-check-empty">{readiness.loading || summary.loading ? "Loading…" : "No checks yet"}</div>}
          >
            <For each={checks()}>{(check) => <LocalCheckRow check={check} />}</For>
          </Show>
        }
      >
        <For each={readinessView()!.checks}>{(check) => <FlatCheckRow check={check} />}</For>
      </Show>
    </div>
  );
}

// ---- Review (agent prompt) ------------------------------------------------

export function ReviewPromptButton(props: { workspace: string }) {
  const [busy, setBusy] = createSignal(false);

  async function queueReviewPrompt() {
    if (busy()) return;
    setBusy(true);
    try {
      const thread = await activeWorkspaceChatThread(props.workspace);
      const prompt = await send({
        type: "get_workspace_git_action_prompt",
        workspace: props.workspace,
        action: "open_pr",
      });
      if (prompt.type === "error") throw new Error(prompt.message);
      if (prompt.type !== "workspace_git_action_prompt") throw new Error("Unable to prepare review prompt.");
      const kind = providerKind(thread.provider);
      nav.selectChatThread(thread.id);
      await send({
        type: "ensure_chat_thread_session",
        workspace: props.workspace,
        thread_id: thread.id,
        kind,
      });
      await send({
        type: "queue_chat_input",
        thread_id: thread.id,
        input: prompt.prompt,
        visible_input: prompt.visible_input,
        kind: "review_prompt",
        session_kind: kind,
      });
      toastsStore.push(`${prompt.visible_input} queued in chat.`);
    } catch (e) {
      toastsStore.error(`Review failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  onMount(() => {
    const onStartReview = () => void queueReviewPrompt();
    window.addEventListener("archductor:start-review", onStartReview);
    onCleanup(() => window.removeEventListener("archductor:start-review", onStartReview));
  });

  return (
    <button class="ws-review-prompt-button" disabled={busy()} onClick={() => void queueReviewPrompt()}>
      {busy() ? "Queueing…" : "Review"}
    </button>
  );
}
