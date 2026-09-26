import type { ArchcarEvent, BackgroundTask, ProviderInteractionRecord } from "@/bridge/protocol";

export interface EventNotification {
  id: string;
  title: string;
  body: string;
}

export function notificationForArchcarEvent(event: ArchcarEvent): EventNotification | null {
  switch (event.type) {
    case "provider_interaction_requested":
      return notificationForInteraction(
        (event as { interaction: ProviderInteractionRecord }).interaction,
      );
    case "turn_completed":
      return notificationForCompletedTurn(
        event as { session_id: number; thread_id: number; status?: string },
      );
    case "session_error":
      return notificationForSessionError(
        event as { session_id?: number; thread_id?: number; message: string },
      );
    case "background_task_updated":
      return notificationForBackgroundTask((event as { task: BackgroundTask }).task);
    default:
      return null;
  }
}

function notificationForInteraction(interaction: ProviderInteractionRecord): EventNotification {
  return {
    id: `interaction-${interaction.id}`,
    title: "Input required",
    body: joinBody(interaction.title, interaction.detail),
  };
}

function notificationForCompletedTurn(event: {
  session_id: number;
  thread_id: number;
  status?: string;
}): EventNotification {
  const status = event.status?.trim() || "completed";
  return {
    id: `turn-${event.session_id}-${event.thread_id}-${status}`,
    title: status === "completed" ? "Chat finished" : "Chat stopped",
    body: `Thread ${event.thread_id} ${status}.`,
  };
}

function notificationForSessionError(event: {
  session_id?: number;
  thread_id?: number;
  message: string;
}): EventNotification {
  return {
    id: `session-error-${event.session_id ?? "unknown"}-${event.thread_id ?? "unknown"}`,
    title: "Chat failed",
    body: event.message,
  };
}

function notificationForBackgroundTask(task: BackgroundTask): EventNotification | null {
  if (task.status !== "ready" && task.status !== "failed") return null;
  return {
    id: `background-task-${task.id}-${task.status}`,
    title: task.status === "ready" ? "Background task ready" : "Background task failed",
    body: `#${task.id} ${task.title}${task.workspace_name ? ` (${task.workspace_name})` : ""}: ${task.detail || task.error || task.status}`,
  };
}

function joinBody(title: string, detail: string): string {
  const cleanTitle = title.trim();
  const cleanDetail = detail.trim();
  if (!cleanTitle) return cleanDetail;
  if (!cleanDetail) return cleanTitle;
  return `${cleanTitle} - ${cleanDetail}`;
}
