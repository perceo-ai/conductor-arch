// Every response the daemon can send back, as one discriminated union.
// --- Responses -------------------------------------------------------------
import type { BackgroundTask } from "./background";
import type { ArchcarMessage, ChatSnapshot, QueuedArchcarInput } from "./chat";
import type { AgentProviderSummary, AgentSkill, LayoutPresetRecord, SessionKind, SyncAction, SyncPlan, WorkflowRunSummary, WorkspaceGitAction } from "./common";
import type { ProviderInteractionRecord } from "./events";
import type { WorkspaceChangeScope } from "./requests";
import type { ArchcarProcessSummary, ArchcarRunScript, SetupReport } from "./setup";
import type { ContextAttachment, ContextBriefing, DiffContribution, SessionContribution, SessionOverlap, SessionRunRecord, Summary, SummaryRefreshResult, Task, TaskSyncResult } from "./tasks";
import type { ArchcarChatThread, ArchcarChatTranscriptMessage, ArchcarChatTranscriptSummary, ArchcarContextPlan, ArchcarProjectionItem, ArchcarRepositorySummary } from "./threads";
import type { ArchcarChecksSummary, ArchcarConfiguredCheck, ArchcarTimelineEvent, ArchcarWorkspaceConflict, ArchcarWorkspaceSummary, Checkpoint, DiffFileSummary, ReviewComment, Todo } from "./workspace";

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
  | {
      type: "inventory_snapshot";
      repositories: ArchcarRepositorySummary[];
      workspaces: ArchcarWorkspaceSummary[];
      chat_threads: Record<string, ArchcarChatThread[]>;
    }
  | { type: "workspaces"; workspaces: ArchcarWorkspaceSummary[] }
  | { type: "repositories"; repositories: ArchcarRepositorySummary[] }
  | { type: "skills"; skills: AgentSkill[] }
  | { type: "workflow_runs"; workspace: string; summary: WorkflowRunSummary }
  | { type: "sync_plan"; plan: SyncPlan }
  | { type: "sync_applied"; applied: SyncAction[] }
  | { type: "chat_threads"; workspace: string; threads: ArchcarChatThread[] }
  | { type: "chat_projection"; thread_id: number; items: ArchcarProjectionItem[] }
  | { type: "chat_transcripts"; workspace: string; transcripts: ArchcarChatTranscriptSummary[] }
  | { type: "chat_transcript"; thread_id: number; title: string; messages: ArchcarChatTranscriptMessage[] }
  | { type: "context_plans"; workspace: string; plans: ArchcarContextPlan[] }
  | { type: "provider_interactions"; interactions: ProviderInteractionRecord[] }
  | {
      type: "chat_plan";
      thread_id: number;
      plan_mode: boolean;
      plan_path?: string;
      plan_markdown?: string;
    }
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
  | { type: "layout_presets"; presets: LayoutPresetRecord[] }
  | { type: "layout_preset_saved"; preset: LayoutPresetRecord }
  | { type: "repository_branches"; repository: string; branches: string[] }
  | { type: "agent_providers"; providers: AgentProviderSummary[] }
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
  | { type: "mcp_registration"; clients: McpClientRegistration[] }
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
  | { type: "tasks_synced"; result: TaskSyncResult }
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

/// One agent CLI's view of the Archductor MCP server.
/// Mirrors crates/core/src/archcar/protocol.rs.
export interface McpClientRegistration {
  client: string; // "claude" | "codex"
  installed: boolean;
  registered: boolean;
  detail?: string;
}

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
