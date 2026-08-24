// Push events from the daemon, and the provider interactions (permission,
// question, plan approval) that block a turn until answered.
// --- Events (streamed after `subscribe`) -----------------------------------
import type { BackgroundTask } from "./background";
import type { SessionKind } from "./common";

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
  | { type: "chat_plan_updated"; thread_id: number; plan_mode: boolean; plan_path?: string }
  | { type: "provider_interaction_requested"; interaction: ProviderInteractionRecord }
  | { type: "provider_interaction_resolved"; interaction: ProviderInteractionRecord }
  | { type: "background_task_updated"; task: BackgroundTask }
  | { type: "summary_updated"; workspace: string; summary_id: number; scope_type: string; scope_id: number }
  | { type: "task_updated"; workspace: string; task_id: number; status: string }
  | { type: "workspace_renamed"; old_name: string; new_name: string }
  | { type: "chat_thread_renamed"; thread_id: number; title: string }
  | { type: "inventory_changed"; scope: string; workspace?: string; repository?: string }
  | { type: string; [k: string]: unknown };

// Agent-driven interaction (permission / question / plan approval) surfaced to
// the user mid-turn. Mirrors crates/core/src/provider_interactions.rs.
export type ProviderInteractionKind = "permission" | "user_question" | "plan_approval";
export interface InteractionOption {
  label: string;
  description: string;
}
export interface InteractionQuestion {
  id: string;
  header: string;
  question: string;
  options: InteractionOption[];
  allow_other: boolean;
  multi_select: boolean;
}
export interface ProviderInteractionRecord {
  id: string;
  provider_key: string;
  workspace: string;
  thread_id: number;
  session_id: number;
  kind: ProviderInteractionKind;
  title: string;
  detail: string;
  questions: InteractionQuestion[];
  auto_resolution_ms?: number;
  /** Workspace-relative path of the plan behind a plan_approval. */
  plan_path?: string;
  status: string;
}
export interface InteractionAnswer {
  question_id: string;
  values: string[];
}
export type ProviderInteractionResolution =
  | { type: "approve" }
  | { type: "approve_for_session" }
  | { type: "deny"; reason?: string }
  | { type: "answer"; answers: InteractionAnswer[] }
  | { type: "defer" };

