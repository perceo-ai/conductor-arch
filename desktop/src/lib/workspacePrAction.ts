import type { ArchcarChecksSummary } from "@/bridge/protocol";
// Type-only, so this stays a compile-time check that every state maps to a
// glyph that actually exists — a missing one is a build error, not a blank
// square someone notices in a screenshot.
import type { IconName } from "@/components/Icon";

export type WorkspacePrActionKind = "create" | "push" | "merge" | "view" | "none";

/**
 * The situation the workspace is in, as opposed to what to do about it.
 *
 * `WorkspacePrActionKind` answers "which button" and necessarily collapses
 * cases: merged, closed, conflicted, checks-failing, checks-running and
 * behind-base all reduce to `view`, because the button is "go look at it" in
 * every one. That collapse is right for a button and wrong for an icon — it is
 * why six genuinely different states used to render the same glyph in the
 * sidebar. This type keeps them distinct.
 *
 * Derived in the same pass as the action so the two cannot drift.
 */
export type WorkspacePrStateKind =
  | "no-changes"
  | "no-pr"
  | "uncommitted"
  | "unpushed"
  | "conflict"
  | "checks-running"
  | "checks-failed"
  | "checks-unknown"
  | "behind-base"
  | "ready"
  | "merged"
  | "closed";

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
  state: WorkspacePrStateKind;
}

export function workspacePrActionInput(
  row:
    | {
        prNumber?: number | null;
        prState?: string | null;
        changedFiles?: number | null;
        branchAhead?: number | null;
        branchBehind?: number | null;
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
    branchAhead: checks?.branch_ahead ?? row?.branchAhead,
    sourceBranchAhead: checks?.source_branch_ahead,
    branchBehind: checks?.branch_behind ?? row?.branchBehind,
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
  const checksPassed =
    check === "success" ||
    check === "passed" ||
    check === "pass";
  const checksFailed =
    check === "failing" ||
    check === "failed" ||
    check === "failure" ||
    check === "error";

  if (!prNumber) {
    if (changed > 0) {
      return {
        title: "No pull request yet",
        cssClass: "ws-pr-status-muted",
        actionLabel: "Create PR",
        action: "create",
        state: "no-pr",
      };
    }
    if (ahead > 0) {
      return {
        title: "Unpushed commits",
        cssClass: "ws-pr-status-pending",
        actionLabel: "Push",
        action: "push",
        state: "unpushed",
      };
    }
    return { title: "No changes", cssClass: "ws-pr-status-muted", action: "none", state: "no-changes" };
  }

  if (prState === "merged")
    return {
      title: `#${prNumber} merged`,
      cssClass: "ws-pr-status-merged",
      actionLabel: "View",
      action: "view",
      state: "merged",
    };
  if (prState === "closed")
    return {
      title: `#${prNumber} closed`,
      cssClass: "ws-pr-status-muted",
      actionLabel: "View",
      action: "view",
      state: "closed",
    };

  if (conflicts > 0)
    return {
      title: "Merge conflicts",
      cssClass: "ws-pr-status-failed",
      actionLabel: "Resolve",
      action: "view",
      state: "conflict",
    };
  if (changed > 0)
    return {
      title: "Uncommitted changes",
      cssClass: "ws-pr-status-pending",
      actionLabel: "Push",
      action: "push",
      state: "uncommitted",
    };
  if (ahead > 0)
    return {
      title: "Unpushed commits",
      cssClass: "ws-pr-status-pending",
      actionLabel: "Push",
      action: "push",
      state: "unpushed",
    };
  if (checksFailed)
    return {
      title: "Checks failing",
      cssClass: "ws-pr-status-failed",
      actionLabel: "Fix Checks",
      action: "view",
      state: "checks-failed",
    };
  if (check === "pending" || check === "running" || check === "queued")
    return {
      title: "Checks running",
      cssClass: "ws-pr-status-pending",
      actionLabel: "Review",
      action: "view",
      state: "checks-running",
    };
  if (behind > 0)
    return {
      title: "Behind base",
      cssClass: "ws-pr-status-pending",
      actionLabel: "Update",
      action: "view",
      state: "behind-base",
    };
  if (!checksPassed)
    return {
      title: "Checks unknown",
      cssClass: "ws-pr-status-pending",
      actionLabel: "Review",
      action: "view",
      state: "checks-unknown",
    };
  return {
    title: "Ready to merge",
    cssClass: "ws-pr-status-ready",
    actionLabel: "Merge",
    action: "merge",
    state: "ready",
  };
}

/** Glyph per state. Distinct per state by design — this is the whole reason
 *  `WorkspacePrStateKind` exists separately from the action kind. */
export const WORKSPACE_PR_STATE_ICON: Record<WorkspacePrStateKind, IconName> = {
  "no-changes": "circle-dashed",
  "no-pr": "git-branch",
  uncommitted: "circle-dot",
  unpushed: "arrow-up-circle",
  conflict: "alert-circle",
  "checks-running": "loader-circle",
  "checks-failed": "circle-x",
  "checks-unknown": "circle-help",
  "behind-base": "arrow-down-circle",
  ready: "circle-check",
  merged: "git-merge",
  closed: "circle-slash",
};

/**
 * States that should animate, and how.
 *
 * `breathe` is ambient and continuous — correct for work genuinely in flight.
 * `attention` is a slow, low-amplitude pulse for states that need a human but
 * are not urgent enough to earn motion that competes with the chat loader.
 * Everything else is deliberately still: if most rows move, movement stops
 * meaning anything.
 */
export const WORKSPACE_PR_STATE_MOTION: Partial<Record<WorkspacePrStateKind, "spin" | "breathe" | "attention">> = {
  "checks-running": "spin",
  conflict: "attention",
  "checks-failed": "attention",
};
