import type { ArchcarChecksSummary } from "@/bridge/protocol";

export type WorkspacePrActionKind = "create" | "push" | "merge" | "view" | "none";

export interface WorkspacePrActionInput {
  prNumber?: number | null;
  prState?: string | null;
  changedFiles?: number | null;
  checkStatus?: string | null;
  checkExitCode?: number | null;
  branchAhead?: number | null;
  sourceBranchAhead?: number | null;
  branchBehind?: number | null;
  conflicts?: number | null;
}

export interface WorkspacePrActionState {
  title: string;
  cssClass: string;
  actionLabel?: string;
  action: WorkspacePrActionKind;
}

export function workspacePrActionInput(
  row:
    | {
        prNumber?: number | null;
        prState?: string | null;
        changedFiles?: number | null;
      }
    | undefined,
  checks: ArchcarChecksSummary | undefined,
): WorkspacePrActionInput {
  return {
    prNumber: row?.prNumber,
    prState: row?.prState,
    changedFiles: row?.changedFiles,
    checkStatus: checks?.check_status,
    checkExitCode: checks?.check_exit_code,
    branchAhead: checks?.branch_ahead,
    sourceBranchAhead: checks?.source_branch_ahead,
    branchBehind: checks?.branch_behind,
    conflicts: checks?.conflicting_workspaces,
  };
}

export function deriveWorkspacePrAction(input: WorkspacePrActionInput): WorkspacePrActionState {
  const prNumber = input.prNumber ?? 0;
  const prState = (input.prState ?? "").toLowerCase();
  const check = (input.checkStatus ?? "").toLowerCase();
  const ahead = input.branchAhead ?? input.sourceBranchAhead ?? 0;
  const behind = input.branchBehind ?? 0;
  const conflicts = input.conflicts ?? 0;
  const changed = input.changedFiles ?? 0;
  const checkExitCode = input.checkExitCode;
  const checksPassed =
    check === "success" ||
    check === "passed" ||
    check === "pass";
  const checksFailed =
    check === "failing" ||
    check === "failed" ||
    check === "failure" ||
    check === "error" ||
    (check === "exited" && checkExitCode != null && checkExitCode !== 0);

  if (!prNumber) {
    if (changed > 0) {
      return {
        title: "No pull request yet",
        cssClass: "ws-pr-status-muted",
        actionLabel: "Create PR",
        action: "create",
      };
    }
    if (ahead > 0) {
      return {
        title: "Unpushed commits",
        cssClass: "ws-pr-status-pending",
        actionLabel: "Push",
        action: "push",
      };
    }
    return { title: "No changes", cssClass: "ws-pr-status-muted", action: "none" };
  }

  if (prState === "merged")
    return { title: `#${prNumber} merged`, cssClass: "ws-pr-status-merged", actionLabel: "View", action: "view" };
  if (prState === "closed")
    return { title: `#${prNumber} closed`, cssClass: "ws-pr-status-muted", actionLabel: "View", action: "view" };

  if (conflicts > 0)
    return { title: "Merge conflicts", cssClass: "ws-pr-status-failed", actionLabel: "Resolve", action: "view" };
  if (changed > 0)
    return { title: "Uncommitted changes", cssClass: "ws-pr-status-pending", actionLabel: "Push", action: "push" };
  if (ahead > 0)
    return { title: "Unpushed commits", cssClass: "ws-pr-status-pending", actionLabel: "Push", action: "push" };
  if (checksFailed)
    return { title: "Checks failing", cssClass: "ws-pr-status-failed", actionLabel: "Fix Checks", action: "view" };
  if (check === "pending" || check === "running" || check === "queued")
    return { title: "Checks running", cssClass: "ws-pr-status-pending", actionLabel: "Review", action: "view" };
  if (behind > 0)
    return { title: "Behind base", cssClass: "ws-pr-status-pending", actionLabel: "Update", action: "view" };
  if (!checksPassed)
    return { title: "Checks unknown", cssClass: "ws-pr-status-pending", actionLabel: "Review", action: "view" };
  return { title: "Ready to merge", cssClass: "ws-pr-status-ready", actionLabel: "Merge", action: "merge" };
}
