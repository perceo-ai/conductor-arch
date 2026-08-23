import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { send, openExternal } from "@/bridge/client";
import { actions, nav, workspacesStore } from "@/store";
import { intelStore } from "@/store/intel";
import { TASK_STATUSES } from "@/bridge/protocol";
import type {
  ArchcarChecksSummary,
  ContextAttachment,
  ContextKind,
  SessionOverlap,
  Summary,
  Task,
  TaskStatus,
  TaskUpdate,
  Todo,
} from "@/bridge/protocol";
import Icon from "@/components/Icon";
import { renderMarkdown } from "@/lib/markdown";
import { relativeTime } from "@/lib/relativeTime";
import { mergeWorkItems, type SummaryWorkItem } from "@/lib/summaryWorkItems";
import { CheckGlyph } from "./WorkspaceTabs";

// The Summary tab: the agent-maintained context surface a human reads to
// understand a workspace. It is a *reading* surface — the records come from
// crates/core/src/workspace_intel.rs and are kept current by archcar, so this
// panel renders them and stays out of the way. It carries no forms; the one
// write it keeps is a task's status, because marking work done is the human's
// job. Context/PR panels below remain for their data models but are not
// registered as right-panel tabs.
//
// Layout follows the Checks tab: a flat scroll of quiet section labels and
// single-line rows on one surface. No nested panels, no cards inside cards.

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- Summary --------------------------------------------------------------

/** One flat row: glyph, title, muted tail. The shape every section here uses. */
function SummaryRow(props: {
  tone?: SummaryWorkItem["tone"];
  icon?: "brain";
  title: string;
  detail?: string;
  children?: JSX.Element;
}) {
  return (
    <div class="ws-summary-row">
      <Show when={props.icon === "brain"} fallback={<CheckGlyph tone={props.tone ?? "unknown"} />}>
        <Icon name="brain" class="ws-summary-row-icon" />
      </Show>
      <span class="ws-summary-row-title" title={props.title}>
        {props.title}
      </span>
      <Show when={props.detail}>
        {(detail) => <span class="ws-summary-row-detail">{detail()}</span>}
      </Show>
      {props.children}
    </div>
  );
}

/** Agent-written prose. Markdown so the reader sees structure, not syntax. */
function Prose(props: { markdown: string }) {
  return <div class="ws-summary-prose markdown-body" innerHTML={renderMarkdown(props.markdown)} />;
}

function WorkItemRow(props: {
  item: SummaryWorkItem;
  onStatus: (item: SummaryWorkItem, status: TaskStatus) => void;
}) {
  return (
    <>
      <SummaryRow tone={props.item.tone} title={props.item.title} detail={props.item.detail}>
        {/* Todos have no update RPC, so only tasks get an editable status. */}
        <Show
          when={props.item.kind === "task"}
          fallback={<span class="ws-summary-row-status">{props.item.status.replace("_", " ")}</span>}
        >
          <select
            class="ws-summary-row-select"
            title="Task status"
            value={props.item.status}
            onChange={(e) => props.onStatus(props.item, e.currentTarget.value as TaskStatus)}
          >
            <For each={TASK_STATUSES}>
              {(status) => <option value={status}>{status.replace("_", " ")}</option>}
            </For>
          </select>
        </Show>
      </SummaryRow>
      <Show when={props.item.blockedReason}>
        {(reason) => <div class="ws-summary-row-note">Blocked: {reason()}</div>}
      </Show>
    </>
  );
}

export function SummaryPanel(props: { workspace: string }) {
  const [stored, { refetch }] = createResource(
    () => `${props.workspace}:${intelStore.version()}`,
    async (): Promise<Summary | null> => {
      try {
        const res = await send({ type: "list_summaries", workspace: props.workspace });
        if (res.type !== "summaries") return null;
        return res.summaries.find((summary) => summary.scope_type === "workspace") ?? null;
      } catch {
        return null;
      }
    },
  );
  const [tasks, { refetch: refetchTasks }] = createResource(
    () => `${props.workspace}:${intelStore.version()}`,
    async (): Promise<Task[]> => {
      try {
        const res = await send({ type: "list_tasks", workspace: props.workspace });
        return res.type === "tasks" ? res.tasks : [];
      } catch {
        return [];
      }
    },
  );
  const [todos] = createResource(
    () => `${props.workspace}:${intelStore.version()}`,
    async (): Promise<Todo[]> => {
      try {
        const res = await send({ type: "list_todos", workspace: props.workspace });
        return res.type === "todos" ? res.todos : [];
      } catch {
        return [];
      }
    },
  );
  const [overlaps] = createResource(
    () => `${props.workspace}:${intelStore.version()}`,
    async (): Promise<SessionOverlap[]> => {
      try {
        const res = await send({ type: "list_session_overlaps", workspace: props.workspace });
        return res.type === "session_overlaps" ? res.overlaps : [];
      } catch {
        return [];
      }
    },
  );
  const [editing, setEditing] = createSignal(false);
  const [draftBody, setDraftBody] = createSignal<string | null>(null);
  const [feedback, setFeedback] = createSignal("");

  const savedText = () => stored()?.body_markdown ?? "";
  // While editing, unsaved keystrokes win; otherwise the stored summary shows.
  const text = () => draftBody() ?? savedText();
  const workItems = createMemo(() => mergeWorkItems(tasks() ?? [], todos() ?? []));

  function startEditing() {
    setDraftBody(savedText());
    setFeedback("");
    setEditing(true);
  }

  function cancelEditing() {
    setDraftBody(null);
    setFeedback("");
    setEditing(false);
  }

  async function refresh() {
    setFeedback("Refreshing…");
    try {
      const res = await send({
        type: "refresh_summary",
        workspace: props.workspace,
        scope_type: "workspace",
      });
      if (res.type === "summary_refreshed") {
        setFeedback(res.result.changed ? "" : "Already up to date.");
        await refetch();
      } else if (res.type === "error") {
        setFeedback(res.message);
      }
    } catch (err) {
      setFeedback(`Refresh failed: ${errorText(err)}`);
    }
  }

  async function draft() {
    setFeedback("Drafting…");
    try {
      const res = await send({ type: "draft_summary", workspace: props.workspace });
      if (res.type === "summary_draft") {
        setDraftBody(res.body_markdown);
        setFeedback("Draft ready — review, then save.");
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
        source_refs: ["human:desktop"],
      });
      if (res.type === "error") {
        setFeedback(res.message);
        return;
      }
      setDraftBody(null);
      setEditing(false);
      setFeedback("");
      await refetch();
    } catch (err) {
      setFeedback(`Save failed: ${errorText(err)}`);
    }
  }

  async function setStatus(item: SummaryWorkItem, status: TaskStatus) {
    const task = (tasks() ?? []).find((candidate) => candidate.id === item.id);
    if (!task) return;
    // Core rejects a blocked task with no reason, so ask rather than fail.
    let update: TaskUpdate = { status };
    if (status === "blocked" && !task.blocked_reason) {
      const reason = window.prompt(`Why is "${task.title}" blocked?`)?.trim();
      if (!reason) return;
      update = { status, blocked_reason: reason };
    } else if (status !== "blocked" && task.blocked_reason) {
      update = { status, blocked_reason: null };
    }
    try {
      const res = await send({
        type: "update_task",
        workspace: props.workspace,
        task_id: task.id,
        update,
      });
      setFeedback(res.type === "error" ? res.message : "");
      await refetchTasks();
    } catch (err) {
      setFeedback(`Update task failed: ${errorText(err)}`);
    }
  }

  const provenance = () => {
    const summary = stored();
    if (!summary) return "No summary yet";
    // Three authors, and which one wrote it changes how much to trust it: the
    // agent's own note, a human's edit, or the daemon's placeholder draft.
    const author = summary.source_refs.includes("human:desktop")
      ? "Human-edited"
      : summary.source_refs.includes("archductor:agent")
        ? "Agent-maintained"
        : "Placeholder draft";
    return `${author} · updated ${relativeTime(summary.updated_at)}`;
  };

  return (
    <div class="ws-tab-panel ws-summary-panel">
      <div class="ws-summary-status">
        <span class="ws-summary-provenance">{provenance()}</span>
        <button class="ws-check-open" title="Refresh summary" onClick={() => void refresh()}>
          <Icon name="refresh" />
        </button>
        <button
          class="ws-check-open"
          title={editing() ? "Stop editing" : "Edit summary"}
          classList={{ "ws-summary-edit-active": editing() }}
          onClick={() => (editing() ? cancelEditing() : startEditing())}
        >
          <Icon name="pencil" />
        </button>
      </div>

      <Show when={feedback()}>
        <div class="ws-summary-feedback">{feedback()}</div>
      </Show>

      <Show
        when={editing()}
        fallback={
          <Show
            when={savedText().trim()}
            fallback={
              <div class="ws-check-empty">
                {stored.loading
                  ? "Loading…"
                  : "No summary yet — it appears once the agent has something to record."}
              </div>
            }
          >
            <Prose markdown={savedText()} />
          </Show>
        }
      >
        <textarea
          class="ws-summary-editor"
          placeholder="What is going on here, for whoever works on this next: the goal, where it stands, decisions made, what is next, open questions."
          value={text()}
          onInput={(e) => setDraftBody(e.currentTarget.value)}
        />
        <div class="ws-summary-edit-actions">
          <button class="suggested-action" onClick={() => void save()}>
            Save
          </button>
          <button class="secondary-action" onClick={() => void draft()}>
            Draft for me
          </button>
          <button class="secondary-action" onClick={cancelEditing}>
            Cancel
          </button>
        </div>
      </Show>

      <CurrentChatSection workspace={props.workspace} />

      <div class="ws-flat-section-label">Tasks</div>
      <Show
        when={workItems().length > 0}
        fallback={
          <div class="ws-check-empty">
            {tasks.loading || todos.loading ? "Loading…" : "No open work tracked in this branch."}
          </div>
        }
      >
        <For each={workItems()}>
          {(item) => <WorkItemRow item={item} onStatus={(i, s) => void setStatus(i, s)} />}
        </For>
      </Show>

      <Show when={(overlaps() ?? []).length > 0}>
        <div class="ws-flat-section-label">Overlapping sessions</div>
        <For each={overlaps()}>
          {(overlap) => (
            <SummaryRow
              tone="running"
              title={`${overlap.session_title} ↔ ${overlap.other_session_title}`}
              detail={`${overlap.paths.length} shared file${overlap.paths.length === 1 ? "" : "s"}`}
            />
          )}
        </For>
      </Show>

    </div>
  );
}

/** Pull the `## Current chat` section out of a context briefing body. */
function extractCurrentChatSection(markdown: string): string | null {
  const match = markdown.match(/## Current chat\n\n([\s\S]*?)(?=\n## |$)/);
  const section = match?.[1]?.trim();
  return section ? section : null;
}

/** Read-only view of the selected chat thread's maintained context. */
function CurrentChatSection(props: { workspace: string }) {
  const threadId = () => nav.selectedChatThread();
  const [chatContext] = createResource(
    () => {
      const id = threadId();
      return id != null ? `${props.workspace}:${id}:${intelStore.version()}` : null;
    },
    async (): Promise<string | null> => {
      const id = threadId();
      if (id == null) return null;
      try {
        const res = await send({
          type: "get_context_briefing",
          workspace: props.workspace,
          thread_id: id,
        });
        if (res.type !== "context_briefing") return null;
        return extractCurrentChatSection(res.briefing.body_markdown);
      } catch {
        return null;
      }
    },
  );
  return (
    <>
      <div class="ws-flat-section-label">Current chat</div>
      <Show
        when={chatContext()}
        fallback={
          <div class="ws-check-empty">
            {threadId() == null
              ? "Select a chat to see its maintained context here."
              : chatContext.loading
                ? "Loading…"
                : "No maintained context for this chat yet — it appears after the next turn."}
          </div>
        }
      >
        {(context) => <Prose markdown={context()} />}
      </Show>
    </>
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
      {/* Archivum context is intentionally not surfaced yet: there is no
          Archivum client, and an empty section would advertise a capability
          that does not exist. The `archivum` attachment source stays in the
          protocol so this can be re-enabled without a migration.

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
      */}
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
