// TypeScript mirror of crates/core/src/archcar/protocol.rs.
// Keep in sync when the Rust protocol changes. serde uses snake_case + an
// internal `type` tag on the request/response/event enums.

export type SessionKind = "shell" | "codex" | "claude";
export type ArchcarInputKind = "user" | "review_prompt" | "control_command" | "raw_terminal";
export type ArchcarInputDelivery = "auto" | "immediate";
export type WorkspaceGitAction = "create_pr" | "push_branch" | "merge_pr" | "open_pr";

// --- Requests (payload of the envelope sent to archcar) --------------------
// Only the variants the UI currently issues are typed here; add as needed.
export type ArchcarRequest =
  | { type: "ensure_chat_thread_session"; workspace: string; thread_id: number; kind: SessionKind }
  | { type: "spawn_session"; workspace: string; kind: SessionKind }
  | {
      type: "send_input";
      session_id: number;
      input: string;
      visible_input?: string;
      kind: ArchcarInputKind;
      delivery?: ArchcarInputDelivery;
    }
  | { type: "interrupt_turn"; session_id: number }
  | { type: "set_session_model"; session_id: number; model?: string }
  | { type: "set_session_effort"; session_id: number; effort?: string }
  | { type: "set_session_permission_mode"; session_id: number; mode: string }
  | { type: "resize_session"; session_id: number; rows: number; cols: number }
  | { type: "get_session_status"; session_id: number }
  | { type: "get_session_screen"; session_id: number }
  | { type: "get_chat_snapshot"; thread_id: number }
  | {
      type: "queue_chat_input";
      thread_id: number;
      input: string;
      visible_input?: string;
      kind: ArchcarInputKind;
      session_kind: SessionKind;
    }
  | { type: "list_queued_chat_inputs"; thread_id: number }
  | { type: "remove_queued_chat_input"; queue_id: number }
  | { type: "move_queued_chat_input"; queue_id: number; up: boolean }
  | { type: "save_chat_paste"; thread_id: number; text: string }
  | { type: "resolve_provider_interaction"; interaction_id: string; resolution: ProviderInteractionResolution }
  | { type: "kill_session"; session_id: number }
  | { type: "list_workspaces" }
  | { type: "list_repositories" }
  | { type: "list_chat_threads"; workspace: string }
  | { type: "get_chat_projection"; thread_id: number }
  | { type: "list_workspace_files"; workspace: string }
  | { type: "read_workspace_file"; workspace: string; path: string }
  | { type: "write_workspace_file"; workspace: string; path: string; content: string }
  | { type: "get_workspace_changes"; workspace: string; scope: WorkspaceChangeScope }
  | { type: "get_workspace_diff"; workspace: string; path?: string }
  | { type: "list_todos"; workspace: string }
  | { type: "add_todo"; workspace: string; text: string }
  | { type: "list_checkpoints"; workspace: string }
  | { type: "create_checkpoint"; workspace: string; message: string }
  | { type: "restore_checkpoint"; workspace: string; checkpoint_id: number }
  | { type: "compare_checkpoint"; workspace: string; checkpoint_id: number }
  | { type: "get_workspace_processes"; workspace: string }
  | { type: "list_workspace_timeline"; workspace: string }
  | { type: "list_workspace_conflicts"; workspace: string }
  | { type: "list_linked_directories"; workspace: string }
  | { type: "get_recent_commits"; workspace: string; limit?: number }
  | { type: "get_commit_message_draft"; workspace: string }
  | { type: "get_commit_diff"; workspace: string; commit: string }
  | { type: "run_workspace_script"; workspace: string }
  | { type: "stop_workspace_script"; workspace: string }
  | { type: "get_run_log"; workspace: string }
  | { type: "list_workspace_checks"; workspace: string }
  | { type: "run_workspace_check"; workspace: string; key: string }
  | { type: "get_check_log"; workspace: string }
  | { type: "commit_workspace_changes"; workspace: string; message: string; stage_all?: boolean }
  | { type: "get_pull_request_readiness"; workspace: string }
  | { type: "get_workspace_git_action_prompt"; workspace: string; action: WorkspaceGitAction }
  | { type: "get_spotlight_status"; workspace: string }
  | { type: "start_spotlight"; workspace: string }
  | { type: "stop_spotlight"; workspace: string }
  | { type: "get_workspace_script_prompt"; workspace: string; kind: "setup" | "run" }
  | { type: "get_workspace_run_scripts"; workspace: string }
  | { type: "start_workspace_setup"; workspace: string }
  | { type: "start_workspace_run"; workspace: string }
  | { type: "stop_workspace_run"; workspace: string }
  | { type: "recover_workspace_lifecycle_jobs" }
  | { type: "list_review_comments"; workspace: string }
  | { type: "get_checks_summary"; workspace: string }
  | { type: "get_settings"; repository?: string }
  | { type: "get_settings_source"; repository?: string; layer?: string }
  | { type: "list_repository_branches"; repository: string }
  | { type: "list_prompt_packs"; repository: string }
  | { type: "set_active_prompt_pack"; repository: string; pack: string }
  | { type: "save_settings"; repository?: string; layer?: string; toml: string }
  | { type: "get_setup_readiness"; recheck?: boolean }
  // Daemon background service + remote access.
  | { type: "get_service_status" }
  | { type: "install_service"; input: { listen?: string; archcar_path?: string } }
  | { type: "uninstall_service" }
  | { type: "get_remote_access" }
  | { type: "rotate_remote_token" }
  // Background development tasks.
  | { type: "start_background_task"; input: StartBackgroundTaskInput }
  | { type: "list_background_tasks"; active_only?: boolean }
  | { type: "get_background_task"; background_task_id: number }
  | { type: "cancel_background_task"; background_task_id: number }
  | { type: "tick_background_tasks" }
  | { type: "create_pull_request"; workspace: string; title?: string; body?: string; draft?: boolean }
  | { type: "get_pull_request_draft"; workspace: string }
  // Workspace intelligence: tasks, summaries, context attachments.
  | { type: "list_tasks"; workspace: string }
  | { type: "create_task"; workspace: string; title: string; body?: string; intended_areas?: string[] }
  | { type: "update_task"; workspace: string; task_id: number; update: TaskUpdate }
  | { type: "delete_task"; workspace: string; task_id: number }
  | { type: "assign_session_task"; workspace: string; session_id: number; task_id?: number }
  | { type: "set_session_intended_areas"; workspace: string; session_id: number; areas: string[] }
  | { type: "list_summaries"; workspace: string }
  | {
      type: "save_summary";
      workspace: string;
      scope_type: SummaryScope;
      scope_id?: number;
      body_markdown: string;
      source_refs?: string[];
    }
  | { type: "delete_summary"; workspace: string; summary_id: number }
  | { type: "draft_summary"; workspace: string; session_id?: number }
  | { type: "refresh_summary"; workspace: string; scope_type: SummaryRefreshScopeType; scope_id?: number }
  | { type: "get_context_briefing"; workspace: string; thread_id?: number }
  | { type: "list_context_attachments"; workspace: string }
  | {
      type: "add_context_attachment";
      workspace: string;
      source: ContextSource;
      kind: ContextKind;
      body_or_ref: string;
      scope?: string;
      pinned?: boolean;
    }
  | { type: "remove_context_attachment"; workspace: string; attachment_id: number }
  | { type: "list_session_contributions"; workspace: string }
  | { type: "list_session_overlaps"; workspace: string }
  | { type: "list_session_runs"; workspace: string; session_id: number }
  | {
      type: "snapshot_diff_contribution";
      workspace: string;
      session_id: number;
      risks?: string[];
      blockers?: string[];
    }
  | { type: "list_diff_contributions"; workspace: string }
  | { type: "create_chat_thread"; workspace: string; provider: string; title: string }
  | { type: "close_chat_thread"; thread_id: number }
  | { type: "reopen_chat_thread"; thread_id: number }
  // Repository & workspace lifecycle (parity with in-process GTK flows).
  | {
      type: "add_repository";
      path: string;
      name?: string;
      remote_name?: string;
      default_branch?: string;
      workspace_parent?: string;
    }
  | { type: "clone_repository"; url: string; dest: string; name?: string }
  | { type: "remove_repository"; repository: string }
  | { type: "create_workspace"; repository: string; name: string; branch: string; base_ref?: string }
  | {
      type: "create_workspace_from_prompt";
      repository: string;
      prompt: string;
      name?: string;
      branch?: string;
      base_ref?: string;
    }
  | { type: "create_workspace_from_issue"; repository: string; issue_number: number; branch_prefix?: string }
  | {
      type: "create_workspace_from_pull_request";
      repository: string;
      pr_number: number;
      name?: string;
      branch?: string;
    }
  | {
      type: "create_workspace_from_linear";
      repository: string;
      issue_id: string;
      name?: string;
      branch?: string;
      base_ref?: string;
    }
  | { type: "archive_workspace"; workspace: string; remove_worktree?: boolean }
  | { type: "restore_workspace"; workspace: string }
  | { type: "rename_workspace"; workspace: string; new_name: string }
  | { type: "duplicate_workspace"; workspace: string; new_name: string; branch?: string }
  | { type: "delete_workspace"; workspace: string; remove_worktree?: boolean; delete_branch?: boolean }
  // Branch, PR, review, checkpoint, linking, provider default.
  | { type: "create_branch"; workspace: string; branch: string }
  | { type: "checkout_branch"; workspace: string; branch: string }
  | { type: "rename_workspace_branch"; workspace: string; new_branch: string }
  | { type: "delete_branch"; workspace: string; branch: string }
  | { type: "push_branch"; workspace: string; force?: boolean }
  | { type: "refresh_pull_request"; workspace: string }
  | { type: "resolve_review_thread"; workspace: string; thread_id: string; resolved: boolean }
  | { type: "merge_pull_request"; workspace: string; method?: string }
  | { type: "add_review_comment"; workspace: string; file_path: string; line_number?: number; body: string }
  | { type: "delete_checkpoint"; workspace: string; checkpoint_id: number }
  | { type: "link_workspace_directory"; workspace: string; target: string }
  | { type: "unlink_workspace_directory"; workspace: string; target: string }
  | { type: "set_default_agent_provider"; workspace: string; provider: string }
  | { type: "subscribe" };

export type WorkspaceChangeScope = "all" | "uncommitted";

// --- Records ---------------------------------------------------------------
export interface ArchcarMessage {
  id: number;
  role: string;
  content: string;
  source: string;
  inline_event?: unknown;
  context_usage?: { percent?: number; used_tokens?: number; total_tokens?: number };
}

export interface QueuedArchcarInput {
  id: number;
  thread_id: number;
  input: string;
  visible_input?: string;
  kind: ArchcarInputKind;
  session_kind: SessionKind;
  created_at: string;
  updated_at: string;
}

export interface ProviderEventRecord {
  id: number;
  identity_key: string;
  provider: string;
  chat_thread_id: number;
  phase: string;
  kind: string;
  normalized_payload: unknown;
  raw_json?: unknown;
  received_sequence: number;
  occurred_at_ms: number;
}

export interface ChatLiveSession {
  session_id: number;
  status: string;
  runtime_state: string;
  ready: boolean;
}

export interface ChatSnapshot {
  thread_id: number;
  messages: ArchcarMessage[];
  events: unknown[];
  provider_events: ProviderEventRecord[];
  queued_inputs: QueuedArchcarInput[];
  live_session?: ChatLiveSession;
}

export interface ArchcarWorkspaceSummary {
  id: number;
  name: string;
  repository_name: string;
  path: string;
  branch: string;
  base_ref: string;
  status: string;
  open_todos: number;
  open_tasks?: number;
  blocked_tasks?: number;
  active_sessions: number;
  run_running: boolean;
  changed_files: number;
  diff_additions: number;
  diff_deletions: number;
  pull_request_number?: number;
  pull_request_state?: string;
  pull_request_url?: string;
  branch_ahead?: number;
  branch_behind?: number;
  updated_at: string;
}

export interface Todo {
  id: number;
  workspace_id: number;
  text: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface Checkpoint {
  id: number;
  workspace_id: number;
  session_id?: number;
  git_ref: string;
  message: string;
  created_at: string;
}

export interface ReviewComment {
  id: number;
  workspace_id: number;
  file_path: string;
  line_number?: number;
  body: string;
  status: string;
  github_thread_id?: string;
  created_at: string;
  updated_at: string;
}

export interface ArchcarConfiguredCheck {
  key: string;
  label: string;
  command: string;
}

export interface ArchcarTimelineEvent {
  id: number;
  kind: string;
  summary: string;
  created_at: string;
}

export interface ArchcarWorkspaceConflict {
  workspace: string;
  files: string[];
}

export interface ArchcarChecksSummary {
  workspace: string;
  changed_files: number;
  run_status?: string;
  check_status?: string;
  check_exit_code?: number;
  session_status?: string;
  active_sessions: number;
  open_todos: number;
  total_todos: number;
  open_review_comments: number;
  source_branch_ahead: number;
  branch_ahead?: number;
  branch_behind?: number;
  pull_request_number?: number;
  pull_request_state?: string;
  conflicting_workspaces: number;
}

export interface DiffFileSummary {
  path: string;
  additions?: number;
  deletions?: number;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface ArchcarProjectionItem {
  id: string;
  sequence: number;
  render_class: string; // user_chat | assistant_chat | reasoning_card | ...
  role_label: string;
  title: string;
  body: string;
  status: string; // pending | running | complete | failed | canceled
  stream_state: string; // snapshot | streaming | complete
}

export interface ArchcarChatThread {
  id: number;
  provider: string;
  title: string;
  status: string;
  /** Explicit model the session was launched with, when recorded. */
  model?: string | null;
  updated_at: string;
  archived_at?: string;
}

export interface ArchcarRepositorySummary {
  id: number;
  name: string;
  root_path: string;
  default_branch: string;
  remote_name: string;
  active_workspaces: number;
  total_workspaces: number;
}

export type SetupRowState = "ready" | "action" | "missing";

export interface SetupRow {
  name: string;
  detail: string;
  state: SetupRowState;
  required: boolean;
}

export interface SetupReport {
  rows: SetupRow[];
  feedback: string;
  complete: boolean;
  refresh_error?: string;
}

export interface ArchcarRunScript {
  id: string;
  command: string;
  available_in: string[];
  default: boolean;
  icon?: string;
  runnable_here: boolean;
  unavailable_reason?: string;
}

export interface ArchcarProcessSummary {
  id: number;
  kind: string;
  pid: number;
  status: string;
  log_path: string;
}

// --- Responses -------------------------------------------------------------
export type ArchcarResponse =
  | { type: "ack" }
  | { type: "session_spawn_queued"; workspace: string; kind: SessionKind }
  | { type: "session_spawned"; session_id: number; thread_id: number; workspace: string; kind: SessionKind; pid: number }
  | { type: "session_messages"; thread_id: number; messages: ArchcarMessage[] }
  | { type: "queued_chat_input"; input: QueuedArchcarInput }
  | { type: "session_status"; session_id: number; status: string; runtime_state: string; ready: boolean }
  | { type: "session_screen"; session_id: number; screen: string }
  | { type: "chat_snapshot"; snapshot: ChatSnapshot }
  | { type: "queued_chat_inputs"; thread_id: number; inputs: QueuedArchcarInput[] }
  | { type: "workspaces"; workspaces: ArchcarWorkspaceSummary[] }
  | { type: "repositories"; repositories: ArchcarRepositorySummary[] }
  | { type: "chat_threads"; workspace: string; threads: ArchcarChatThread[] }
  | { type: "chat_projection"; thread_id: number; items: ArchcarProjectionItem[] }
  | { type: "workspace_files"; workspace: string; files: string[] }
  | { type: "workspace_file_content"; workspace: string; path: string; content: string }
  | { type: "workspace_file_written"; workspace: string; path: string }
  | {
      type: "workspace_changes";
      workspace: string;
      scope: WorkspaceChangeScope;
      files: DiffFileSummary[];
    }
  | { type: "workspace_diff"; workspace: string; diff: string }
  | { type: "todos"; workspace: string; todos: Todo[] }
  | { type: "todo_added"; todo: Todo }
  | { type: "checkpoints"; workspace: string; checkpoints: Checkpoint[] }
  | { type: "checkpoint_saved"; checkpoint: Checkpoint }
  | {
      type: "checkpoint_diff";
      workspace: string;
      checkpoint_id: number;
      diff: string;
      truncated: boolean;
    }
  | { type: "workspace_processes"; workspace: string; text: string }
  | { type: "workspace_timeline"; workspace: string; events: ArchcarTimelineEvent[] }
  | { type: "workspace_conflicts"; workspace: string; conflicts: ArchcarWorkspaceConflict[] }
  | {
      type: "linked_directories";
      workspace: string;
      directories: { target_workspace: string; link_path: string; created_at: string }[];
    }
  | { type: "recent_commits"; workspace: string; log: string }
  | { type: "commit_message_draft"; workspace: string; message: string }
  | { type: "commit_diff"; workspace: string; commit: string; diff: string }
  | { type: "run_script_started"; workspace: string; pid: number; log_path: string }
  | { type: "run_script_stopped"; workspace: string; pid: number }
  | { type: "run_log"; workspace: string; log: string }
  | { type: "workspace_checks"; workspace: string; checks: ArchcarConfiguredCheck[] }
  | { type: "check_started"; workspace: string; key: string; pid: number; log_path: string }
  | { type: "check_log"; workspace: string; log: string }
  | { type: "workspace_committed"; workspace: string; output: string }
  | { type: "pull_request_readiness"; workspace: string; text: string }
  | {
      type: "workspace_git_action_prompt";
      workspace: string;
      action: WorkspaceGitAction;
      prompt: string;
      visible_input: string;
    }
  | { type: "spotlight_status"; workspace: string; active: boolean; status?: string; started_at?: string }
  | { type: "workspace_script_prompt"; workspace: string; kind: string; prompt: string }
  | { type: "workspace_run_scripts"; workspace: string; scripts: ArchcarRunScript[] }
  | { type: "workspace_process_started"; workspace: string; process: ArchcarProcessSummary }
  | { type: "workspace_process_stopped"; workspace: string; process: ArchcarProcessSummary }
  | { type: "workspace_lifecycle_recovery"; recovered: number; reconciled_processes: number }
  | { type: "review_comments"; workspace: string; comments: ReviewComment[] }
  | { type: "checks_summary"; workspace: string; summary: ArchcarChecksSummary }
  | { type: "settings"; scope: string; toml: string }
  | { type: "repository_branches"; repository: string; branches: string[] }
  | { type: "prompt_packs"; repository: string; packs: string[]; active?: string }
  | { type: "settings_source"; scope: string; layer: string; toml: string }
  | { type: "settings_saved"; scope: string; layer: string }
  | { type: "setup_readiness"; report: SetupReport }
  | { type: "chat_thread_created"; thread: ArchcarChatThread }
  | { type: "repository_added"; name: string }
  | { type: "repository_removed"; name: string }
  | { type: "chat_paste_saved"; relative_path: string; label: string }
  | { type: "workspace_created"; name: string }
  | { type: "workspace_updated"; name: string }
  | { type: "workspace_removed"; name: string }
  | { type: "review_comment_added"; comment: ReviewComment }
  | { type: "service_status"; status: ServiceStatus }
  | { type: "remote_access"; listen?: string; token: string; token_path: string }
  | { type: "background_task_saved"; task: BackgroundTask }
  | { type: "background_tasks"; tasks: BackgroundTask[] }
  | { type: "pull_request_created"; workspace: string; output: string }
  | { type: "pull_request_draft"; workspace: string; title: string; body: string }
  | { type: "tasks"; workspace: string; tasks: Task[] }
  | { type: "task_saved"; task: Task }
  | { type: "task_deleted"; task_id: number }
  | { type: "summaries"; workspace: string; summaries: Summary[] }
  | { type: "summary_saved"; summary: Summary }
  | { type: "summary_deleted"; summary_id: number }
  | { type: "summary_draft"; workspace: string; body_markdown: string }
  | { type: "summary_refreshed"; workspace: string; result: SummaryRefreshResult }
  | { type: "context_briefing"; briefing: ContextBriefing }
  | { type: "context_attachments"; workspace: string; attachments: ContextAttachment[] }
  | { type: "context_attachment_added"; attachment: ContextAttachment }
  | { type: "context_attachment_removed"; attachment_id: number }
  | { type: "session_contributions"; workspace: string; contributions: SessionContribution[] }
  | { type: "session_overlaps"; workspace: string; overlaps: SessionOverlap[] }
  | { type: "session_runs"; workspace: string; session_id: number; runs: SessionRunRecord[] }
  | { type: "diff_contribution_saved"; contribution: DiffContribution }
  | { type: "diff_contributions"; workspace: string; contributions: DiffContribution[] }
  | { type: "error"; message: string };

// --- Daemon service (launchd / systemd) ------------------------------------
// Mirrors crates/core/src/service.rs.

export interface ServiceStatus {
  manager: string; // "launchd" | "systemd" | "unsupported"
  installed: boolean;
  running: boolean;
  unit_path?: string | null;
  listen?: string | null;
  detail: string;
}

// --- Background development tasks -----------------------------------------
// Mirrors crates/core/src/background_tasks.rs.

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

// --- Events (streamed after `subscribe`) -----------------------------------
export type ArchcarEvent =
  | { type: "session_spawn_queued"; workspace: string; kind: SessionKind }
  | { type: "session_started"; session_id: number; thread_id: number; workspace: string; kind: SessionKind; pid: number }
  | { type: "session_ready"; session_id: number; thread_id: number }
  | { type: "turn_completed"; session_id: number; thread_id: number; status?: string }
  | { type: "session_screen_updated"; session_id: number }
  | { type: "session_messages_updated"; thread_id: number }
  | { type: "chat_queue_updated"; thread_id: number }
  | { type: "session_exited"; session_id: number; exit_code?: number }
  | { type: "session_error"; session_id?: number; thread_id?: number; message: string }
  | { type: "provider_interaction_requested"; interaction: ProviderInteractionRecord }
  | { type: "provider_interaction_resolved"; interaction: ProviderInteractionRecord }
  | { type: "background_task_updated"; task: BackgroundTask }
  | { type: "summary_updated"; workspace: string; summary_id: number; scope_type: string; scope_id: number }
  | { type: "task_updated"; workspace: string; task_id: number; status: string }
  | { type: string; [k: string]: unknown };

// Agent-driven interaction (permission / question / plan approval) surfaced to
// the user mid-turn. Mirrors crates/core/src/provider_interactions.rs.
export type ProviderInteractionKind = "permission" | "user_question" | "plan_approval";
export interface ProviderInteractionRecord {
  id: string;
  provider_key: string;
  workspace: string;
  thread_id: number;
  session_id: number;
  kind: ProviderInteractionKind;
  title: string;
  detail: string;
  choices: string[];
  status: string;
}
export type ProviderInteractionResolution =
  | { type: "approve" }
  | { type: "deny"; reason?: string }
  | { type: "answer"; answers: [string, string][] }
  | { type: "defer" };
