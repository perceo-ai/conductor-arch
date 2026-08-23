// Background tasks queued against a repository, and their lifecycle states.
export type BackgroundTaskStatus =
  | "pending"
  | "running"
  | "checking"
  | "summarizing"
  | "opening_pr"
  | "ready"
  | "failed"
  | "cancelled";

export const BACKGROUND_TASK_TERMINAL: BackgroundTaskStatus[] = ["ready", "failed", "cancelled"];

export interface BackgroundTask {
  id: number;
  repository_name: string;
  workspace_name?: string | null;
  task_id?: number | null;
  title: string;
  prompt: string;
  provider: string;
  status: BackgroundTaskStatus;
  run_checks: boolean;
  open_pr: boolean;
  draft_pr: boolean;
  detail: string;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BackgroundAgentSpec {
  provider: string;
  /** Prompt for this agent; defaults to the task prompt when omitted. */
  prompt?: string;
}

export interface StartBackgroundTaskInput {
  repository: string;
  prompt: string;
  title?: string;
  workspace_name?: string;
  branch?: string;
  base_ref?: string;
  provider: string;
  run_checks: boolean;
  open_pr: boolean;
  draft_pr: boolean;
  /** Extra agents to run in the same workspace beyond the primary provider. */
  extra_agents?: BackgroundAgentSpec[];
}

// --- Workspace intelligence records ---------------------------------------
// Mirrors crates/core/src/workspace_intel.rs.

