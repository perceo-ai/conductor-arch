// TypeScript mirror of crates/core/src/archcar/protocol.rs.
// Keep in sync when the Rust protocol changes. serde uses snake_case + an
// internal `type` tag on the request/response/event enums.

export type SessionKind = "shell" | "codex" | "claude";
export type ArchcarInputKind = "user" | "review_prompt" | "control_command" | "raw_terminal";
export type ArchcarInputDelivery = "auto" | "immediate";

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
  | { type: "get_workspace_changes"; workspace: string; scope: WorkspaceChangeScope }
  | { type: "get_workspace_diff"; workspace: string; path?: string }
  | { type: "list_todos"; workspace: string }
  | { type: "add_todo"; workspace: string; text: string }
  | { type: "list_checkpoints"; workspace: string }
  | { type: "create_checkpoint"; workspace: string; message: string }
  | { type: "restore_checkpoint"; workspace: string; checkpoint_id: number }
  | { type: "get_workspace_processes"; workspace: string }
  | { type: "list_review_comments"; workspace: string }
  | { type: "get_checks_summary"; workspace: string }
  | { type: "get_settings"; repository?: string }
  | { type: "get_setup_readiness"; recheck?: boolean }
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
  branch: string;
  base_ref: string;
  status: string;
  open_todos: number;
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

export interface ArchcarChecksSummary {
  workspace: string;
  changed_files: number;
  run_status?: string;
  check_status?: string;
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
  | { type: "workspace_processes"; workspace: string; text: string }
  | { type: "review_comments"; workspace: string; comments: ReviewComment[] }
  | { type: "checks_summary"; workspace: string; summary: ArchcarChecksSummary }
  | { type: "settings"; scope: string; toml: string }
  | { type: "setup_readiness"; report: SetupReport }
  | { type: "chat_thread_created"; thread: ArchcarChatThread }
  | { type: "repository_added"; name: string }
  | { type: "repository_removed"; name: string }
  | { type: "chat_paste_saved"; relative_path: string; label: string }
  | { type: "workspace_created"; name: string }
  | { type: "workspace_updated"; name: string }
  | { type: "workspace_removed"; name: string }
  | { type: "review_comment_added"; comment: ReviewComment }
  | { type: "error"; message: string };

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
