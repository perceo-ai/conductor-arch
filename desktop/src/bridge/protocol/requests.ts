// Every request this client can send the daemon, as one discriminated union.
// --- Requests (payload of the envelope sent to archcar) --------------------
// Only the variants the UI currently issues are typed here; add as needed.
import type { StartBackgroundTaskInput } from "./background";
import type {
  ArchcarInputDelivery,
  ArchcarInputKind,
  SessionKind,
  SyncSelection,
  WorkspaceGitAction,
} from "./common";
import type { ProviderInteractionResolution } from "./events";
import type { ContextKind, ContextSource, SummaryRefreshScopeType, SummaryScope, TaskUpdate } from "./tasks";

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
  | { type: "set_session_fast_mode"; session_id: number; fast_mode: boolean }
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
  | { type: "list_provider_interactions"; thread_id?: number; pending_only: boolean }
  | { type: "set_chat_plan_mode"; thread_id: number; plan_mode: boolean }
  | { type: "get_chat_plan"; thread_id: number }
  | { type: "kill_session"; session_id: number }
  | { type: "get_inventory_snapshot" }
  | { type: "list_workspaces" }
  | { type: "list_repositories" }
  | { type: "list_skills" }
  | { type: "list_workflow_runs"; workspace: string }
  | { type: "get_sync_plan"; selection?: SyncSelection }
  | { type: "apply_sync"; selection?: SyncSelection }
  | { type: "list_chat_threads"; workspace: string }
  | { type: "get_chat_projection"; thread_id: number }
  | { type: "list_chat_transcripts"; workspace: string; limit?: number }
  | { type: "get_chat_transcript"; thread_id: number }
  | { type: "list_context_plans"; workspace: string }
  | { type: "list_workspace_files"; workspace: string }
  | { type: "read_workspace_file"; workspace: string; path: string }
  | { type: "write_workspace_file"; workspace: string; path: string; content: string }
  | { type: "get_workspace_changes"; workspace: string; scope: WorkspaceChangeScope }
  | {
      type: "get_workspace_diff";
      workspace: string;
      path?: string;
      scope?: WorkspaceChangeScope;
    }
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
  | { type: "get_commit_diff"; workspace: string; commit: string; path?: string }
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
  | { type: "list_agent_providers" }
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
  // Archductor's own MCP server, registered with the agent CLIs on this device.
  | { type: "get_mcp_registration" }
  | {
      type: "set_mcp_registration";
      register: boolean;
      clients?: string[];
      session_profile?: boolean;
    }
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
  | { type: "sync_chat_tasks"; workspace: string; thread_id?: number }
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

// Mirrors WorkspaceChangeScope in crates/core/src/archcar/protocol.rs. The same
// scope drives the changes list and the diff for a file opened from it.
export type WorkspaceChangeScope = "all" | "uncommitted" | { commit: { sha: string } };

export function commitScopeSha(scope: WorkspaceChangeScope): string | null {
  return typeof scope === "object" ? scope.commit.sha : null;
}

