// Chat transport: messages, the queued-input buffer, provider event records,
// and the live-session snapshot a chat renders from.
// --- Records ---------------------------------------------------------------
import type { ArchcarInputKind, SessionKind } from "./common";

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

