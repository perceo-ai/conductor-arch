// Projected timeline items, chat threads, saved transcripts, and the
// repository summary.
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
  effort_mode?: string | null;
  fast_mode: boolean;
  updated_at: string;
  archived_at?: string;
}

/** Past chat offered as attachable context on the new-chat screen. */
export interface ArchcarChatTranscriptSummary {
  thread_id: number;
  title: string;
  provider: string;
  /** Number of user + agent messages the transcript would carry. */
  message_count: number;
  updated_at: string;
}

/** One transcript line: `user` or `agent`, never a tool call. */
export interface ArchcarChatTranscriptMessage {
  role: string;
  content: string;
  created_at: string;
}

/** Plan markdown file under the workspace's `.context/plans/`. */
export interface ArchcarContextPlan {
  name: string;
  path: string;
  title: string;
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

