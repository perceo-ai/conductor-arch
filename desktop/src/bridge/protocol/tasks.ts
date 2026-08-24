// Workspace intelligence: tasks, operational summaries, context attachments,
// and per-session diff contributions.
export type TaskStatus = "todo" | "in_progress" | "blocked" | "review" | "done";
export const TASK_STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "review", "done"];

export type SummaryScope = "workspace" | "session" | "task" | "review" | "handoff";
export type ContextSource = "local" | "archivum";
export type ContextKind = "note" | "summary" | "context_pack" | "file" | "memory";

export interface Task {
  id: number;
  workspace_id: number;
  title: string;
  body: string;
  status: TaskStatus;
  owner_session_id?: number | null;
  /** Human owner (name/handle), distinct from the owning agent session. */
  owner?: string | null;
  intended_areas: string[];
  blocked_reason?: string | null;
  /** Notes left for/by the reviewer of this task's work. */
  review_notes: string;
  /** Sessions attached to this task via their `task_id`. */
  linked_session_ids: number[];
  created_at: string;
  updated_at: string;
}

/** Partial update; omitted fields stay unchanged. */
export interface TaskUpdate {
  title?: string;
  body?: string;
  status?: TaskStatus;
  /** `null` detaches the owning session. */
  owner_session_id?: number | null;
  /** `null` (or an empty string) clears the human owner. */
  owner?: string | null;
  intended_areas?: string[];
  /** `null` clears the blocked reason. */
  blocked_reason?: string | null;
  review_notes?: string;
}

export interface Summary {
  id: number;
  workspace_id: number;
  scope_type: SummaryScope;
  scope_id: number;
  body_markdown: string;
  source_refs: string[];
  created_at: string;
  updated_at: string;
}

/** Wire scopes accepted by `refresh_summary` (`current_chat` aliases `session`). */
export type SummaryRefreshScopeType = "workspace" | "session" | "current_chat" | "task";

/** Evidence cursor recorded by the last auto-refresh of one summary scope. */
export interface SummaryRefreshState {
  id: number;
  workspace_id: number;
  scope_type: string;
  scope_id: number;
  source: string;
  evidence_hash: string;
  latest_message_id?: number | null;
  latest_provider_sequence?: number | null;
  last_refreshed_at: string;
}

export interface SummaryRefreshResult {
  summary: Summary;
  state: SummaryRefreshState;
  changed: boolean;
}

/** Outcome of extracting native tasks from chat evidence. */
export interface TaskSyncResult {
  workspace: string;
  thread_id?: number | null;
  created: number;
  updated: number;
  task_ids: number[];
}

/** Combined workspace/current-chat/tasks/next-actions briefing. */
export interface ContextBriefing {
  workspace: string;
  thread_id?: number | null;
  body_markdown: string;
  summary_ids: number[];
  task_ids: number[];
}

export interface ContextAttachment {
  id: number;
  workspace_id: number;
  source: ContextSource;
  kind: ContextKind;
  body_or_ref: string;
  scope: string;
  pinned: boolean;
  created_at: string;
}

export interface SessionContribution {
  session_id: number;
  title: string;
  provider: string;
  /** Explicit model the session was launched with, when recorded. */
  model?: string | null;
  status: string;
  task_id?: number | null;
  task_title?: string | null;
  files_touched: string[];
  still_present: string[];
  intended_areas: string[];
  summary?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionOverlap {
  session_id: number;
  session_title: string;
  other_session_id: number;
  other_session_title: string;
  paths: string[];
}

/** Durable snapshot of one session's diff contribution. */
export interface DiffContribution {
  id: number;
  workspace_id: number;
  session_id: number;
  files: string[];
  still_present: string[];
  /** Workspace-relative path of the stored patch, when one existed. */
  patch_ref?: string | null;
  commands: string[];
  risks: string[];
  blockers: string[];
  created_at: string;
  updated_at: string;
}

/** One command/check/run the daemon executed for a session. */
export interface SessionRunRecord {
  process_id: number;
  kind: string;
  command: string;
  status: string;
  exit_code?: number | null;
  started_at: string;
  ended_at?: string | null;
}

