// Workspace state: the summary row, review artifacts (todos, checkpoints,
// comments), check/conflict status, and diff shapes.
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
  /** An agent here is parked on a question or permission prompt. */
  awaiting_input?: boolean;
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

