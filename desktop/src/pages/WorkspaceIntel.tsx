import { For, Show, createResource, createSignal } from "solid-js";
import { send, openExternal } from "@/bridge/client";
import { actions, workspacesStore } from "@/store";
import { TASK_STATUSES } from "@/bridge/protocol";
import type {
  ArchcarChecksSummary,
  ContextAttachment,
  ContextKind,
  SessionContribution,
  SessionOverlap,
  Summary,
  Task,
  TaskStatus,
  TaskUpdate,
} from "@/bridge/protocol";
import { TodosPanel, TimelinePanel } from "./WorkspaceTabs";

// Right-panel surfaces for the workspace-intelligence objects added in
// crates/core/src/workspace_intel.rs: Tasks (who is doing what in this branch),
// Summary (branch-local continuity + per-agent diff contributions), Context
// (branch-local pinned notes/files, and Archivum context when connected), and
// PR (the review handoff boundary).

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- Tasks ----------------------------------------------------------------

export function TasksPanel(props: { workspace: string }) {
  const [tasks, { refetch }] = createResource(
    () => props.workspace,
    async (ws): Promise<Task[]> => {
      try {
        const res = await send({ type: "list_tasks", workspace: ws });
        return res.type === "tasks" ? res.tasks : [];
      } catch {
        return [];
      }
    },
  );
  const [overlaps] = createResource(
    () => props.workspace,
    async (ws): Promise<SessionOverlap[]> => {
      try {
        const res = await send({ type: "list_session_overlaps", workspace: ws });
        return res.type === "session_overlaps" ? res.overlaps : [];
      } catch {
        return [];
      }
    },
  );
  const [title, setTitle] = createSignal("");
  const [areas, setAreas] = createSignal("");
  const [feedback, setFeedback] = createSignal("");

  async function create() {
    const value = title().trim();
    if (!value) {
      setFeedback("Task title is required.");
      return;
    }
    try {
      await send({
        type: "create_task",
        workspace: props.workspace,
        title: value,
        body: "",
        intended_areas: areas()
          .split(",")
          .map((area) => area.trim())
          .filter(Boolean),
      });
      setTitle("");
      setAreas("");
      setFeedback("");
      await refetch();
    } catch (err) {
      setFeedback(`Create task failed: ${errorText(err)}`);
    }
  }

  async function update(task: Task, update: TaskUpdate) {
    try {
      const res = await send({
        type: "update_task",
        workspace: props.workspace,
        task_id: task.id,
        update,
      });
      if (res.type === "error") setFeedback(res.message);
      else setFeedback("");
      await refetch();
    } catch (err) {
      setFeedback(`Update task failed: ${errorText(err)}`);
    }
  }

  async function setStatus(task: Task, status: TaskStatus) {
    // Blocked tasks must carry a reason; ask for one rather than failing in core.
    if (status === "blocked" && !task.blocked_reason) {
      const reason = window.prompt(`Why is "${task.title}" blocked?`)?.trim();
      if (!reason) return;
      await update(task, { status, blocked_reason: reason });
      return;
    }
    await update(task, {
      status,
      ...(status !== "blocked" && task.blocked_reason ? { blocked_reason: null } : {}),
    });
  }

  async function remove(task: Task) {
    try {
      await send({ type: "delete_task", workspace: props.workspace, task_id: task.id });
      await refetch();
    } catch (err) {
      setFeedback(`Delete task failed: ${errorText(err)}`);
    }
  }

  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Tasks</div>
      <div class="action-row">
        <input
          class="ws-text-input"
          placeholder="Task title…"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
        />
        <button class="suggested-action" onClick={() => void create()}>
          Add task
        </button>
      </div>
      <div class="action-row">
        <input
          class="ws-text-input"
          placeholder="Intended areas (comma separated)"
          value={areas()}
          onInput={(e) => setAreas(e.currentTarget.value)}
        />
      </div>
      <Show when={feedback()}>
        <div class="card-meta">{feedback()}</div>
      </Show>
      <Show
        when={(tasks() ?? []).length > 0}
        fallback={
          <div class="empty-state">
            {tasks.loading ? "Loading…" : "No tasks yet. Tasks organize intent inside this branch."}
          </div>
        }
      >
        <For each={tasks()}>
          {(task) => (
            <div class="ws-task-row" classList={{ "ws-task-blocked": task.status === "blocked" }}>
              <div class="action-row">
                <span class="detail-value" style={{ flex: "1 1 auto" }}>
                  #{task.id} {task.title}
                </span>
                <select
                  class="ws-text-input ws-task-status"
                  value={task.status}
                  onChange={(e) => void setStatus(task, e.currentTarget.value as TaskStatus)}
                >
                  <For each={TASK_STATUSES}>
                    {(status) => <option value={status}>{status.replace("_", " ")}</option>}
                  </For>
                </select>
                <button class="ui-button-destructive" onClick={() => void remove(task)}>
                  Delete
                </button>
              </div>
              <Show when={task.blocked_reason}>
                <div class="card-meta">Blocked: {task.blocked_reason}</div>
              </Show>
              <Show when={task.intended_areas.length > 0}>
                <div class="card-meta">Areas: {task.intended_areas.join(", ")}</div>
              </Show>
            </div>
          )}
        </For>
      </Show>
      <Show when={(overlaps() ?? []).length > 0}>
        <div class="detail-label">Overlapping sessions</div>
        <For each={overlaps()}>
          {(overlap) => (
            <div class="detail-row ws-overlap-row">
              <span class="detail-label">
                {overlap.session_title} ↔ {overlap.other_session_title}
              </span>
              <span class="detail-value">{overlap.paths.join(", ")}</span>
            </div>
          )}
        </For>
      </Show>
      <TodosPanel workspace={props.workspace} />
    </div>
  );
}

// ---- Summary --------------------------------------------------------------

export function SummaryPanel(props: { workspace: string }) {
  const [stored, { refetch }] = createResource(
    () => props.workspace,
    async (ws): Promise<Summary | null> => {
      try {
        const res = await send({ type: "list_summaries", workspace: ws });
        if (res.type !== "summaries") return null;
        return res.summaries.find((summary) => summary.scope_type === "workspace") ?? null;
      } catch {
        return null;
      }
    },
  );
  const [contributions, { refetch: refetchContributions }] = createResource(
    () => props.workspace,
    async (ws): Promise<SessionContribution[]> => {
      try {
        const res = await send({ type: "list_session_contributions", workspace: ws });
        return res.type === "session_contributions" ? res.contributions : [];
      } catch {
        return [];
      }
    },
  );
  const [body, setBody] = createSignal<string | null>(null);
  const [feedback, setFeedback] = createSignal("");

  // The editor shows unsaved edits when present, otherwise the stored summary.
  const text = () => body() ?? stored()?.body_markdown ?? "";

  async function draft(sessionId?: number) {
    setFeedback("Drafting…");
    try {
      const res = await send({
        type: "draft_summary",
        workspace: props.workspace,
        ...(sessionId != null ? { session_id: sessionId } : {}),
      });
      if (res.type === "summary_draft") {
        setBody(res.body_markdown);
        setFeedback("Draft ready — review, then Save.");
      } else if (res.type === "error") {
        setFeedback(res.message);
      }
    } catch (err) {
      setFeedback(`Draft failed: ${errorText(err)}`);
    }
  }

  async function save() {
    const value = text().trim();
    if (!value) {
      setFeedback("Nothing to save.");
      return;
    }
    try {
      const res = await send({
        type: "save_summary",
        workspace: props.workspace,
        scope_type: "workspace",
        body_markdown: value,
        source_refs: [],
      });
      if (res.type === "error") setFeedback(res.message);
      else {
        setBody(null);
        setFeedback("Saved.");
        await refetch();
      }
    } catch (err) {
      setFeedback(`Save failed: ${errorText(err)}`);
    }
  }

  async function saveSessionSummary(contribution: SessionContribution) {
    setFeedback(`Drafting summary for ${contribution.title}…`);
    try {
      const drafted = await send({
        type: "draft_summary",
        workspace: props.workspace,
        session_id: contribution.session_id,
      });
      if (drafted.type !== "summary_draft") {
        setFeedback(drafted.type === "error" ? drafted.message : "Draft unavailable.");
        return;
      }
      const res = await send({
        type: "save_summary",
        workspace: props.workspace,
        scope_type: "session",
        scope_id: contribution.session_id,
        body_markdown: drafted.body_markdown,
        source_refs: [],
      });
      setFeedback(res.type === "error" ? res.message : `Saved summary for ${contribution.title}.`);
      await refetchContributions();
    } catch (err) {
      setFeedback(`Session summary failed: ${errorText(err)}`);
    }
  }

  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Summary</div>
      <div class="action-row">
        <button class="secondary-action" onClick={() => void draft()}>
          Draft from workspace
        </button>
        <button class="suggested-action" onClick={() => void save()}>
          Save
        </button>
        <Show when={body() != null}>
          <button class="secondary-action" onClick={() => setBody(null)}>
            Discard edits
          </button>
        </Show>
      </div>
      <Show when={feedback()}>
        <div class="card-meta">{feedback()}</div>
      </Show>
      <Show when={stored()}>
        {(summary) => <div class="card-meta">Stored summary updated {summary().updated_at}</div>}
      </Show>
      <textarea
        class="ws-summary-editor"
        placeholder="Branch-local summary: goal, files touched, decisions, checks, blockers, next actions."
        value={text()}
        onInput={(e) => setBody(e.currentTarget.value)}
      />
      <div class="detail-label">Agent contributions</div>
      <Show
        when={(contributions() ?? []).length > 0}
        fallback={
          <div class="empty-state">
            {contributions.loading ? "Loading…" : "No agent sessions in this workspace yet."}
          </div>
        }
      >
        <For each={contributions()}>
          {(contribution) => (
            <div class="ws-contribution-row">
              <div class="action-row">
                <span class="detail-value" style={{ flex: "1 1 auto" }}>
                  {contribution.title}
                </span>
                <button
                  class="secondary-action"
                  onClick={() => void saveSessionSummary(contribution)}
                >
                  Summarize
                </button>
              </div>
              <div class="card-meta">
                {contribution.provider} · {contribution.status} ·{" "}
                {contribution.files_touched.length} file(s) touched ·{" "}
                {contribution.still_present.length} still changed
                <Show when={contribution.task_title}>{(t) => <> · task: {t()}</>}</Show>
              </div>
              <Show when={contribution.files_touched.length > 0}>
                <div class="card-meta ws-contribution-files">
                  {contribution.files_touched.slice(0, 8).join(", ")}
                  {contribution.files_touched.length > 8
                    ? ` +${contribution.files_touched.length - 8} more`
                    : ""}
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
      <TimelinePanel workspace={props.workspace} />
    </div>
  );
}

// ---- Context --------------------------------------------------------------

const CONTEXT_KINDS: ContextKind[] = ["note", "file", "summary", "context_pack", "memory"];

export function ContextPanel(props: { workspace: string }) {
  const [attachments, { refetch }] = createResource(
    () => props.workspace,
    async (ws): Promise<ContextAttachment[]> => {
      try {
        const res = await send({ type: "list_context_attachments", workspace: ws });
        return res.type === "context_attachments" ? res.attachments : [];
      } catch {
        return [];
      }
    },
  );
  const [value, setValue] = createSignal("");
  const [kind, setKind] = createSignal<ContextKind>("note");
  const [feedback, setFeedback] = createSignal("");

  const local = () => (attachments() ?? []).filter((a) => a.source === "local");
  const archivum = () => (attachments() ?? []).filter((a) => a.source === "archivum");

  async function add(pinned: boolean) {
    const body = value().trim();
    if (!body) {
      setFeedback("Enter a note or a file path.");
      return;
    }
    try {
      const res = await send({
        type: "add_context_attachment",
        workspace: props.workspace,
        source: "local",
        kind: kind(),
        body_or_ref: body,
        pinned,
      });
      if (res.type === "error") setFeedback(res.message);
      else {
        setValue("");
        setFeedback("");
        await refetch();
      }
    } catch (err) {
      setFeedback(`Add context failed: ${errorText(err)}`);
    }
  }

  async function remove(attachment: ContextAttachment) {
    try {
      await send({
        type: "remove_context_attachment",
        workspace: props.workspace,
        attachment_id: attachment.id,
      });
      await refetch();
    } catch (err) {
      setFeedback(`Remove context failed: ${errorText(err)}`);
    }
  }

  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Context</div>
      <div class="card-meta">
        Branch-local continuity for this workspace — not durable memory.
      </div>
      <div class="action-row">
        <select
          class="ws-text-input ws-context-kind"
          value={kind()}
          onChange={(e) => setKind(e.currentTarget.value as ContextKind)}
        >
          <For each={CONTEXT_KINDS}>
            {(k) => <option value={k}>{k.replace("_", " ")}</option>}
          </For>
        </select>
        <input
          class="ws-text-input"
          placeholder="Note text or file path…"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void add(false)}
        />
      </div>
      <div class="action-row">
        <button class="secondary-action" onClick={() => void add(false)}>
          Add
        </button>
        <button class="suggested-action" onClick={() => void add(true)}>
          Add pinned
        </button>
      </div>
      <Show when={feedback()}>
        <div class="card-meta">{feedback()}</div>
      </Show>
      <Show
        when={local().length > 0}
        fallback={
          <div class="empty-state">
            {attachments.loading ? "Loading…" : "No pinned notes or files yet."}
          </div>
        }
      >
        <For each={local()}>
          {(attachment) => (
            <div class="detail-row ws-context-row">
              <span class="detail-label">
                {attachment.pinned ? "📌 " : ""}
                {attachment.kind}
              </span>
              <span class="detail-value">{attachment.body_or_ref}</span>
              <button class="ui-button-destructive" onClick={() => void remove(attachment)}>
                Remove
              </button>
            </div>
          )}
        </For>
      </Show>
      <div class="detail-label">Archivum</div>
      <Show
        when={archivum().length > 0}
        fallback={
          <div class="empty-state">
            Archivum is not connected. When it is, retrieved memory and context packs appear here
            with their sources.
          </div>
        }
      >
        <For each={archivum()}>
          {(attachment) => (
            <div class="detail-row ws-context-row">
              <span class="detail-label">
                {attachment.kind}
                {attachment.scope ? ` · ${attachment.scope}` : ""}
              </span>
              <span class="detail-value">{attachment.body_or_ref}</span>
              <button class="ui-button-destructive" onClick={() => void remove(attachment)}>
                Remove
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// ---- PR -------------------------------------------------------------------

export function PrPanel(props: { workspace: string }) {
  const row = () => workspacesStore.row(props.workspace);
  const [checks, { refetch: refetchChecks }] = createResource(
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
  const [title, setTitle] = createSignal<string | null>(null);
  const [body, setBody] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal(false);
  const [feedback, setFeedback] = createSignal("");
  const [readiness, setReadiness] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function loadDraft() {
    setFeedback("Drafting pull request…");
    try {
      const res = await send({ type: "get_pull_request_draft", workspace: props.workspace });
      if (res.type === "pull_request_draft") {
        setTitle(res.title);
        setBody(res.body);
        setFeedback("Draft ready — edit, then Create PR.");
      } else if (res.type === "error") {
        setFeedback(res.message);
      }
    } catch (err) {
      setFeedback(`Draft failed: ${errorText(err)}`);
    }
  }

  async function createPr() {
    if (busy()) return;
    setBusy(true);
    setFeedback("Creating pull request…");
    try {
      const res = await send({
        type: "create_pull_request",
        workspace: props.workspace,
        ...(title()?.trim() ? { title: title()!.trim() } : {}),
        ...(body()?.trim() ? { body: body()!.trim() } : {}),
        draft: draft(),
      });
      if (res.type === "pull_request_created") {
        setFeedback(res.output.trim() || "Pull request created.");
        await actions.refreshPullRequest(props.workspace).catch(() => {});
        await refetchChecks();
      } else if (res.type === "error") {
        setFeedback(res.message);
      }
    } catch (err) {
      setFeedback(`Create PR failed: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const run = (label: string, fn: () => Promise<void>) => async () => {
    setFeedback(`${label}…`);
    try {
      await fn();
      setFeedback(`${label} ok`);
      await refetchChecks();
    } catch (err) {
      setFeedback(`${label} failed: ${errorText(err)}`);
    }
  };

  async function loadReadiness() {
    setReadiness("Loading…");
    try {
      const res = await send({ type: "get_pull_request_readiness", workspace: props.workspace });
      if (res.type === "pull_request_readiness") setReadiness(res.text || "No readiness detail.");
      else if (res.type === "error") setReadiness(res.message);
      else setReadiness("Unavailable.");
    } catch (err) {
      setReadiness(errorText(err));
    }
  }

  return (
    <div class="ws-tab-panel command-panel">
      <div class="section-title">Pull request</div>
      <div class="detail-row">
        <span class="detail-label">State</span>
        <span class="detail-value">
          {row()?.prNumber != null
            ? `#${row()!.prNumber} ${row()?.prState ?? ""}`.trim()
            : "No pull request yet"}
        </span>
      </div>
      <Show when={checks()}>
        {(summary) => (
          <div class="detail-row">
            <span class="detail-label">Branch</span>
            <span class="detail-value">
              {summary().branch_ahead ?? summary().source_branch_ahead} ahead /{" "}
              {summary().branch_behind ?? 0} behind · {summary().changed_files} changed file(s)
            </span>
          </div>
        )}
      </Show>
      <Show when={feedback()}>
        <div class="card-meta">{feedback()}</div>
      </Show>

      <div class="detail-label">Draft</div>
      <div class="action-row">
        <button class="secondary-action" onClick={() => void loadDraft()}>
          Generate from workspace
        </button>
        <label class="ws-pr-draft-toggle">
          <input
            type="checkbox"
            checked={draft()}
            onChange={(e) => setDraft(e.currentTarget.checked)}
          />
          Open as draft PR
        </label>
      </div>
      <input
        class="ws-text-input"
        placeholder="Pull request title"
        value={title() ?? ""}
        onInput={(e) => setTitle(e.currentTarget.value)}
      />
      <textarea
        class="ws-summary-editor"
        placeholder="Pull request body: summary, agent contributions, check evidence, risks."
        value={body() ?? ""}
        onInput={(e) => setBody(e.currentTarget.value)}
      />

      <div class="detail-label">Actions</div>
      <div class="action-row ws-pr-actions-row">
        <button class="suggested-action" disabled={busy()} onClick={() => void createPr()}>
          Create PR
        </button>
        <button
          class="secondary-action"
          onClick={run("Push branch", () => actions.pushBranch(props.workspace))}
        >
          Push branch
        </button>
        <button
          class="secondary-action"
          onClick={run("Refresh PR", () => actions.refreshPullRequest(props.workspace))}
        >
          Refresh
        </button>
        <button
          class="secondary-action"
          onClick={run("Merge PR", () => actions.mergePullRequest(props.workspace))}
        >
          Merge PR
        </button>
        <button
          class="secondary-action ws-force-push-action"
          onClick={run("Force push", () => actions.pushBranch(props.workspace, true))}
        >
          Force push
        </button>
        <Show when={row()?.prUrl}>
          {(url) => (
            <button class="secondary-action" onClick={() => void openExternal(url())}>
              Open in browser
            </button>
          )}
        </Show>
        <button class="secondary-action" onClick={() => void loadReadiness()}>
          Readiness detail
        </button>
      </div>
      <Show when={readiness() != null}>
        <pre class="ws-pr-readiness">{readiness()}</pre>
      </Show>
    </div>
  );
}
