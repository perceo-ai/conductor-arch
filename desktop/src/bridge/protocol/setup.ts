// First-run readiness reporting, plus run scripts and live processes.
export type SetupRowState = "ready" | "action" | "missing";

export type FileAccessState = "granted" | "denied" | "absent";

/** One folder the daemon probed on its own host. */
export interface FileAccessProbe {
  root: string;
  state: FileAccessState;
  detail: string;
  registered?: boolean;
}

export interface SetupRow {
  name: string;
  detail: string;
  state: SetupRowState;
  required: boolean;
  action?: string;
}

export interface SetupReport {
  rows: SetupRow[];
  file_access?: FileAccessProbe[];
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

