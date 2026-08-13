import type { BackgroundTask, BackgroundTaskStatus } from "@/bridge/protocol";

// Pure presentation helpers for background development tasks (mirrors
// crates/core/src/background_tasks.rs). Kept dependency-free so the stage
// labels and progress ordering are unit-testable without a running daemon.

export type BackgroundTaskTone = "waiting" | "active" | "ready" | "failed" | "cancelled";

/** Ordered working stages; terminal statuses sit outside the progress track. */
export const BACKGROUND_TASK_STAGES: BackgroundTaskStatus[] = [
  "pending",
  "running",
  "checking",
  "summarizing",
  "opening_pr",
];

const STAGE_LABELS: Record<BackgroundTaskStatus, string> = {
  pending: "Starting agent",
  running: "Agent working",
  checking: "Running checks",
  summarizing: "Writing summary",
  opening_pr: "Opening pull request",
  ready: "Ready for review",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function backgroundTaskStageLabel(status: BackgroundTaskStatus): string {
  return STAGE_LABELS[status] ?? status;
}

export function backgroundTaskTone(status: BackgroundTaskStatus): BackgroundTaskTone {
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "pending") return "waiting";
  return "active";
}

export function backgroundTaskIsActive(status: BackgroundTaskStatus): boolean {
  return backgroundTaskTone(status) === "waiting" || backgroundTaskTone(status) === "active";
}

/** 0…1 across the working stages; terminal statuses report a full bar. */
export function backgroundTaskProgress(status: BackgroundTaskStatus): number {
  const index = BACKGROUND_TASK_STAGES.indexOf(status);
  if (index < 0) return 1;
  return (index + 1) / (BACKGROUND_TASK_STAGES.length + 1);
}

/** One-line status for a task row: stage, then the daemon's own detail. */
export function backgroundTaskSummary(task: BackgroundTask): string {
  const stage = backgroundTaskStageLabel(task.status);
  const detail = task.error?.trim() || task.detail?.trim();
  return detail ? `${stage} — ${detail}` : stage;
}
