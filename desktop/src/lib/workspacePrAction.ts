import type { ArchcarChecksSummary, PullRequestCheckCounts } from "@/bridge/protocol";
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
  branchChanged?: boolean;
  checkStatus?: string | null;
  /** GitHub CI rollup stored at the last PR sync ("passing" | "failing" | "pending"). */
  prChecks?: string | null;
  /** Per-outcome split of that rollup, for "X/Y passed, Z running". */
  prCheckCounts?: PullRequestCheckCounts | null;
  checkExitCode?: number | null;
  branchAhead?: number | null;
  sourceBranchAhead?: number | null;
  branchBehind?: number | null;
  conflicts?: number | null;
}

export interface WorkspacePrActionState {
  title: string;
  /** Check tally behind the title ("11/20 passed, 8 running"), when GitHub gave one. */
  detail?: string;
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
        prChecks?: string | null;
        prCheckCounts?: PullRequestCheckCounts | null;
        changedFiles?: number | null;
        additions?: number | null;
        deletions?: number | null;
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
    branchChanged: (row?.additions ?? 0) > 0 || (row?.deletions ?? 0) > 0,
    checkStatus: checks?.check_status,
    prChecks: checks?.pull_request_checks ?? row?.prChecks,
    prCheckCounts: checks?.pull_request_check_counts ?? row?.prCheckCounts,
    checkExitCode: checks?.check_exit_code,
    branchAhead: checks?.branch_ahead ?? row?.branchAhead,
    sourceBranchAhead: checks?.source_branch_ahead,
    branchBehind: checks?.branch_behind ?? row?.branchBehind,
    conflicts: checks?.conflicting_workspaces,
  };
}

/**
 * Whether the PR bar should re-read this workspace's PR from GitHub.
 *
 * An open PR: yes — CI finishes (or is re-run) long after the turn that
 * pushed. No PR recorded yet: yes if the branch has work, because a PR opened
 * outside Archductor (gh CLI, web UI) is only found by asking; the daemon
 * discovers it by branch. Merged/closed, or nothing to open a PR for: no.
 */
export function shouldSyncPullRequest(
  row:
    | {
        prNumber?: number | null;
        prState?: string | null;
        additions?: number | null;
        deletions?: number | null;
      }
    | undefined,
): boolean {
  if (!row) return false;
  if (!row.prNumber) return (row.additions ?? 0) > 0 || (row.deletions ?? 0) > 0;
  return (row.prState ?? "open").toLowerCase() === "open";
}

/** Local check-script states that are process lifecycle, not a verdict. An
 *  exit — even exit 0 — says nothing about the PR's revision. */
const LOCAL_NON_VERDICTS = new Set(["exited", "stopped"]);

/** "11/20 passed, 1 failed, 8 running" — skipped runs stay out of the
 *  denominator, as on GitHub. Mirrors `PullRequestCheckCounts::label` in core. */
export function checkCountsLabel(counts: PullRequestCheckCounts): string {
  const ran = counts.total - counts.skipped;
  // "0/0 passed" says nothing; a skipped-only PR reads "2 skipped".
  const parts = ran > 0 ? [`${counts.passed}/${ran} passed`] : [];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.pending > 0) parts.push(`${counts.pending} running`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  return parts.join(", ");
}

export function deriveWorkspacePrAction(input: WorkspacePrActionInput): WorkspacePrActionState {
  const state = withReportedChecksTitle(deriveWorkspacePrActionState(input), input.prCheckCounts);
  // Only tally once the PR is waiting on GitHub rather than on local work;
  // "Merge conflicts · 3/3 passed" would bury the thing that needs doing.
  const aboutChecks =
    state.state === "checks-failed" ||
    state.state === "checks-running" ||
    state.state === "checks-unknown" ||
    state.state === "behind-base" ||
    state.state === "ready";
  return aboutChecks && input.prCheckCounts && input.prCheckCounts.total > 0
    ? { ...state, detail: checkCountsLabel(input.prCheckCounts) }
    : state;
}

/** "No checks reported" is only true when GitHub reported none. Checks that
 *  ran without a verdict we recognise — all skipped, or a state outside the
 *  known vocabulary — say so instead. */
function withReportedChecksTitle(
  state: WorkspacePrActionState,
  counts: PullRequestCheckCounts | null | undefined,
): WorkspacePrActionState {
  if (state.state !== "checks-unknown" || !counts || counts.total === 0) return state;
  return {
    ...state,
    title: counts.skipped === counts.total ? "Checks skipped" : "Checks inconclusive",
  };
}

function deriveWorkspacePrActionState(input: WorkspacePrActionInput): WorkspacePrActionState {
  const prNumber = input.prNumber ?? 0;
  const prState = (input.prState ?? "").toLowerCase();
  // A live local check verdict when there is one; otherwise the GitHub CI
  // rollup recorded at the last PR sync. A finished local run ("exited") is
  // not a verdict and must not hide GitHub's — that is what kept every
  // workspace that had ever run its check script on "Checks unknown".
  const local = (input.checkStatus ?? "").toLowerCase();
  const check = (
    local && !LOCAL_NON_VERDICTS.has(local) ? local : (input.prChecks ?? "")
  ).toLowerCase();
  const ahead = input.branchAhead ?? input.sourceBranchAhead ?? 0;
  const behind = input.branchBehind ?? 0;
  const conflicts = input.conflicts ?? 0;
  const changed = input.changedFiles ?? 0;
  const checksPassed =
    check === "success" ||
    check === "passed" ||
    check === "passing" ||
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
    if (input.branchChanged) {
      return {
        title: "No pull request yet",
        cssClass: "ws-pr-status-muted",
        actionLabel: "Create PR",
        action: "create",
        state: "no-pr",
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
  // Not a warning: most often the PR simply has no CI, or no sync has read it
  // yet. Muted, and a PR glyph rather than a question mark on every row.
  if (!checksPassed)
    return {
      title: "No checks reported",
      cssClass: "ws-pr-status-muted",
      actionLabel: "Review",
      action: "view",
      state: "checks-unknown",
    };
  return {
    title: "Checks passed",
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
  "checks-unknown": "git-pull-request",
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
