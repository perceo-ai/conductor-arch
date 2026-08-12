import { workspaceStatusKind, STATUS_LABEL, type WorkspaceStatusInput } from "./workspaceStatus";

export interface WorkspaceBriefingRow extends WorkspaceStatusInput {
  additions?: number;
  deletions?: number;
  openTodos?: number;
}

export interface WorkspaceBriefingChecks {
  check_status?: string;
  run_status?: string;
  active_sessions?: number;
  open_todos?: number;
  open_review_comments: number;
  branch_behind?: number;
  pull_request_number?: number;
  pull_request_state?: string;
  conflicting_workspaces: number;
}

export interface WorkspaceBriefing {
  status: ReturnType<typeof workspaceStatusKind>;
  topbarSummary: string;
  nextAction: string;
  tiles: Array<{
    label: "Agents" | "Scripts" | "Checks" | "Review" | "Changes";
    value: string;
    tone: "running" | "review" | "changes" | "danger" | "idle";
  }>;
}

function plural(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function activeAgentText(value: number) {
  return value === 1 ? "1 agent active" : `${value} agents active`;
}

function checkFailed(status: string | undefined) {
  return ["fail", "failing", "failure", "error"].some((needle) =>
    (status ?? "").toLowerCase().includes(needle),
  );
}

function checkRunning(status: string | undefined) {
  return ["pending", "running", "queued"].includes((status ?? "").toLowerCase());
}

export function deriveWorkspaceBriefing(
  row: WorkspaceBriefingRow | undefined,
  checks: WorkspaceBriefingChecks | undefined,
): WorkspaceBriefing {
  const status = workspaceStatusKind(row ?? {});
  if (!row) {
    return {
      status,
      topbarSummary: "Workspace loading",
      nextAction: "Loading workspace state",
      tiles: [
        { label: "Agents", value: "Loading", tone: "idle" },
        { label: "Scripts", value: "Loading", tone: "idle" },
        { label: "Checks", value: "Loading", tone: "idle" },
        { label: "Review", value: "Loading", tone: "idle" },
        { label: "Changes", value: "Loading", tone: "idle" },
      ],
    };
  }

  const prNumber = checks?.pull_request_number ?? row.prNumber;
  const prState = checks?.pull_request_state ?? row.prState;
  const activeSessions = checks?.active_sessions ?? row.activeSessions ?? 0;
  const runRunning = row.runRunning || (checks?.run_status ?? "").toLowerCase() === "running";
  const changedFiles = row.changedFiles ?? 0;
  const openTodos = row.openTodos ?? checks?.open_todos ?? 0;
  const reviewComments = checks?.open_review_comments ?? 0;
  const conflicts = checks?.conflicting_workspaces ?? 0;
  const behind = checks?.branch_behind ?? 0;
  const failedChecks = checkFailed(checks?.check_status);
  const runningChecks = checkRunning(checks?.check_status);

  let topbarSummary = "Ready for next task";
  if (activeSessions > 0) topbarSummary = activeAgentText(activeSessions);
  else if (runRunning) topbarSummary = "Run script active";
  else if (prNumber != null && failedChecks) topbarSummary = `PR #${prNumber} checks failing`;
  else if (prNumber != null && (prState ?? "").toLowerCase() === "open")
    topbarSummary = `PR #${prNumber} open`;
  else if (changedFiles > 0) topbarSummary = plural(changedFiles, "changed file");

  let nextAction = "Start an agent, run setup, or open a task source";
  if (activeSessions > 0 || runRunning) nextAction = "Watch agent output and steer when needed";
  else if (reviewComments > 0) nextAction = `Resolve ${plural(reviewComments, "review comment")}`;
  else if (openTodos > 0) nextAction = `Clear ${plural(openTodos, "todo")} before review`;
  else if (failedChecks) nextAction = "Fix failing checks before merge";
  else if (conflicts > 0) nextAction = `Resolve ${plural(conflicts, "conflicting workspace")}`;
  else if (behind > 0) nextAction = `Update from base branch (${behind} behind)`;
  else if (changedFiles > 0 && prNumber == null) nextAction = "Review changes, then push or open a PR";
  else if (prNumber != null && (prState ?? "").toLowerCase() === "open") {
    nextAction = "Check readiness and resolve review blockers";
  }

  const checksValue = failedChecks
    ? "Failing"
    : runningChecks
      ? "Running"
      : checks?.check_status || "Not run";
  const reviewValue =
    reviewComments > 0
      ? plural(reviewComments, "comment")
      : prNumber != null
        ? `PR #${prNumber}${prState ? ` ${prState}` : ""}`
        : "No PR";
  const diffValue =
    changedFiles === 0
      ? "Clean tree"
      : `${plural(changedFiles, "file")} · +${row.additions ?? 0} -${row.deletions ?? 0}`;

  return {
    status,
    topbarSummary,
    nextAction,
    tiles: [
      {
        label: "Agents",
        value: activeSessions > 0 ? plural(activeSessions, "agent") : "Idle",
        tone: activeSessions > 0 ? "running" : "idle",
      },
      {
        label: "Scripts",
        value: runRunning ? "Run active" : checks?.run_status || "Idle",
        tone: runRunning ? "running" : "idle",
      },
      {
        label: "Checks",
        value: checksValue,
        tone: failedChecks ? "danger" : runningChecks ? "running" : "idle",
      },
      {
        label: "Review",
        value: reviewValue,
        tone: reviewComments > 0 ? "danger" : prNumber != null ? "review" : "idle",
      },
      {
        label: "Changes",
        value: diffValue,
        tone: changedFiles > 0 ? "changes" : "idle",
      },
    ],
  };
}

export function workspaceBriefingStatusLabel(briefing: WorkspaceBriefing) {
  return STATUS_LABEL[briefing.status];
}
