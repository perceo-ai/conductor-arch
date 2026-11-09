import type { ArchcarEvent, BackgroundTask, ProviderInteractionRecord } from "@/bridge/protocol";
import { modelLabel } from "@/lib/models";

export interface EventNotification {
  id: string;
  title: string;
  body: string;
}

/**
 * What the app already knows about the chat an event names, so a notification
 * can read "antix · fix the parser / Done in 4m 12s" instead of "Chat
 * finished / Thread 9 completed.". Every field is optional: a missing one only
 * costs detail, never the notification.
 *
 * The wording is mirrored by `event_notification` in
 * `crates/core/src/notifications.rs` (the APNs copy) and
 * `EventNotificationDescriptor` on iOS. Change all three together.
 */
export interface NotificationContext {
  workspace?: string | null;
  chatTitle?: string | null;
  /** The model the chat runs, when recorded; `provider` is the fallback. */
  model?: string | null;
  provider?: string | null;
}

/**
 * Longest chat title kept in a notification title. Past this the rest of the
 * line (the workspace, which says *where*) is what gets pushed off screen.
 */
const CHAT_TITLE_MAX = 44;
/**
 * Longest body. macOS shows roughly two lines, iOS three; past this a
 * notification is a wall of text nobody reads at a glance.
 */
const BODY_MAX = 120;

export function notificationForArchcarEvent(
  event: ArchcarEvent,
  context: NotificationContext = {},
): EventNotification | null {
  switch (event.type) {
    case "provider_interaction_requested":
      return notificationForInteraction(
        (event as { interaction: ProviderInteractionRecord }).interaction,
        context,
      );
    case "turn_completed":
      return notificationForCompletedTurn(
        event as { session_id: number; thread_id: number; status?: string; duration_ms?: number },
        context,
      );
    case "session_error":
      return notificationForSessionError(
        event as { session_id?: number; thread_id?: number; message: string },
        context,
      );
    case "background_task_updated":
      return notificationForBackgroundTask((event as { task: BackgroundTask }).task);
    default:
      return null;
  }
}

function notificationForInteraction(
  interaction: ProviderInteractionRecord,
  context: NotificationContext,
): EventNotification {
  // The interaction carries its own workspace; the chat title and agent come
  // from the thread list, when it has loaded them.
  const merged: NotificationContext = {
    ...context,
    workspace: nonEmpty(interaction.workspace) ?? context.workspace,
    provider: nonEmpty(interaction.provider_key) ?? context.provider,
  };
  return {
    id: `interaction-${interaction.id}`,
    title: chatHeadline(merged, interaction.thread_id),
    body: truncated(
      prefixedDetail("Needs you", joinedDetail(interaction.title, interaction.detail)),
      BODY_MAX,
    ),
  };
}

function notificationForCompletedTurn(
  event: { session_id: number; thread_id: number; status?: string; duration_ms?: number },
  context: NotificationContext,
): EventNotification {
  const status = nonEmpty(event.status) ?? "completed";
  return {
    id: `turn-${event.session_id}-${event.thread_id}-${status}`,
    title: chatHeadline(context, event.thread_id),
    body: turnBody(status, event.duration_ms, context),
  };
}

function notificationForSessionError(
  event: { session_id?: number; thread_id?: number; message: string },
  context: NotificationContext,
): EventNotification {
  return {
    id: `session-error-${event.session_id ?? "unknown"}-${event.thread_id ?? "unknown"}`,
    title: chatHeadline(context, event.thread_id),
    body: truncated(prefixedDetail("Failed", event.message), BODY_MAX),
  };
}

function notificationForBackgroundTask(task: BackgroundTask): EventNotification | null {
  if (task.status !== "ready" && task.status !== "failed") return null;
  const detail = nonEmpty(task.detail) ?? nonEmpty(task.error) ?? "";
  return {
    id: `background-task-${task.id}-${task.status}`,
    title: chatHeadline({ workspace: task.workspace_name, chatTitle: task.title }, undefined),
    body: truncated(
      prefixedDetail(task.status === "ready" ? "Task ready" : "Task failed", detail),
      BODY_MAX,
    ),
  };
}

/**
 * The notification title: which chat this is about, as "workspace · chat
 * title". Falls back through whichever half is known, and to the thread number
 * when neither is.
 */
function chatHeadline(context: NotificationContext, threadId: number | undefined): string {
  const workspace = nonEmpty(context.workspace);
  const chatTitle = nonEmpty(context.chatTitle);
  const title = chatTitle ? truncated(chatTitle, CHAT_TITLE_MAX) : undefined;
  if (workspace && title) return `${workspace} · ${title}`;
  if (workspace) return workspace;
  if (title) return title;
  return threadId == null ? "Archductor" : `Thread ${threadId}`;
}

/**
 * "Done in 4m 12s · Claude Opus 5": what happened, how long it took, who ran
 * it. Enough to decide whether to go back to this chat without opening it.
 */
function turnBody(
  status: string,
  durationMs: number | undefined,
  context: NotificationContext,
): string {
  const [label, preposition] = turnOutcome(status);
  const parts = [
    durationMs == null ? label : `${label} ${preposition} ${formatTurnDuration(durationMs)}`,
  ];
  const agent = agentLabel(context);
  if (agent) parts.push(agent);
  return truncated(parts.join(" · "), BODY_MAX);
}

/**
 * How a finished turn reads, and the preposition its duration needs. An
 * unknown status is shown as it arrived rather than being flattened into
 * "stopped", which is what made every successful claude turn ("success") read
 * as a failure.
 */
function turnOutcome(status: string): [string, string] {
  switch (status.toLowerCase()) {
    case "completed":
    case "success":
    case "succeeded":
    case "ok":
      return ["Done", "in"];
    case "failed":
    case "error":
    case "errored":
      return ["Failed", "after"];
    case "interrupted":
    case "cancelled":
    case "canceled":
    case "stopped":
    case "aborted":
      return ["Stopped", "after"];
    case "deferred":
    case "queued":
    case "paused":
      return ["Paused", "after"];
    default:
      return [capitalized(status), "after"];
  }
}

/** Who ran the turn: the model when the chat records one, else the provider. */
function agentLabel(context: NotificationContext): string | undefined {
  const model = nonEmpty(context.model);
  if (model) return modelLabel(model);
  const provider = nonEmpty(context.provider);
  return provider ? capitalized(provider) : undefined;
}

/**
 * "840ms", "18.3s", "4m 12s" — the same shape as
 * `format_provider_turn_duration` in the daemon, so a banner and the turn row
 * in the chat read the same duration.
 */
export function formatTurnDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** "Approve command? — cargo test": the ask, then what it is about. */
function joinedDetail(title: string, detail: string): string {
  const cleanTitle = collapsed(title);
  const cleanDetail = collapsed(detail);
  if (!cleanTitle) return cleanDetail;
  if (!cleanDetail) return cleanTitle;
  return `${cleanTitle} — ${cleanDetail}`;
}

/**
 * "Failed: codex exited" — the lead says what kind of event this is, the
 * detail says what to do about it.
 */
function prefixedDetail(lead: string, detail: string): string {
  const clean = collapsed(detail);
  return clean ? `${lead}: ${clean}` : lead;
}

function capitalized(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : "";
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Notification bodies are one line of plain text: a wrapped agent message or a
 * multi-line error renders as a ragged block, so whitespace is collapsed
 * before anything is measured or cut.
 */
function collapsed(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Cuts at a word boundary, so a clipped line ends "so every…" rather than "so
 * every s…". Falls back to a hard cut for a single long word (a path, a URL)
 * that has no boundary to fall back to.
 */
function truncated(value: string, max: number): string {
  const clean = collapsed(value);
  const chars = [...clean];
  if (chars.length <= max) return clean;
  let kept = chars.slice(0, max - 1).join("");
  const nextIsBoundary = /\s/.test(chars[max - 1] ?? "");
  if (!nextIsBoundary) {
    const boundary = kept.lastIndexOf(" ");
    if (boundary > 0) kept = kept.slice(0, boundary);
  }
  return `${kept.trimEnd()}…`;
}
