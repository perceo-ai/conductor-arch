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
  | { type: "kill_session"; session_id: number }
  | { type: "list_workspaces" }
  | { type: "list_repositories" }
  | { type: "list_chat_threads"; workspace: string }
  | { type: "get_chat_projection"; thread_id: number }
  | { type: "list_workspace_files"; workspace: string }
  | { type: "get_workspace_changes"; workspace: string; scope: WorkspaceChangeScope }
  | { type: "get_workspace_diff"; workspace: string; path?: string }
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
  | { type: string; [k: string]: unknown };
