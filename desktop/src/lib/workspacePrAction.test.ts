import { describe, expect, it } from "vitest";
import {
  WORKSPACE_PR_STATE_ICON,
  WORKSPACE_PR_STATE_MOTION,
  deriveWorkspacePrAction,
  shouldSyncPullRequest,
  workspacePrActionInput,
  type WorkspacePrActionInput,
  type WorkspacePrStateKind,
} from "./workspacePrAction";

describe("deriveWorkspacePrAction", () => {
  it("promotes local changes to a create PR action", () => {
    expect(deriveWorkspacePrAction({ changedFiles: 2 })).toMatchObject({
      title: "No pull request yet",
      actionLabel: "Create PR",
      action: "create",
    });
  });

  it("keeps ahead-only branches on push until a PR exists", () => {
    expect(deriveWorkspacePrAction({ branchAhead: 1 })).toMatchObject({
      title: "Unpushed commits",
      actionLabel: "Push",
      action: "push",
    });
  });

  it("uses workspace row branch state when checks are not loaded", () => {
    expect(
      deriveWorkspacePrAction(
        workspacePrActionInput({ branchAhead: 1, branchBehind: 0, changedFiles: 0 }, undefined),
      ),
    ).toMatchObject({
      title: "Unpushed commits",
      action: "push",
    });
  });

  it("offers to create a PR for committed branch changes in a clean worktree", () => {
    expect(
      deriveWorkspacePrAction(
        workspacePrActionInput(
          {
            additions: 4,
            deletions: 1,
            changedFiles: 0,
            branchAhead: 0,
            branchBehind: 0,
          },
          undefined,
        ),
      ),
    ).toMatchObject({
      title: "No pull request yet",
      actionLabel: "Create PR",
      action: "create",
      state: "no-pr",
    });
  });

  it("does not treat a local successful check process as full merge readiness", () => {
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        checkStatus: "exited",
        checkExitCode: 0,
      }),
    ).toMatchObject({
      title: "No checks reported",
      actionLabel: "Review",
      action: "view",
    });
  });

  it("moves open clean PRs to merge only with an explicit passed status", () => {
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        checkStatus: "success",
      }),
    ).toMatchObject({
      title: "Checks passed",
      actionLabel: "Merge",
      action: "merge",
    });
  });

  it("does not expose merge until checks are positively known to have passed", () => {
    for (const checkStatus of [undefined, "exited", "stopped"]) {
      expect(
        deriveWorkspacePrAction({
          prNumber: 42,
          prState: "open",
          checkStatus,
        }),
      ).toMatchObject({
        title: "No checks reported",
        actionLabel: "Review",
        action: "view",
      });
    }
  });

  it("uses the stored GitHub rollup when no local check process has run", () => {
    // The daemon records the CI rollup on the pull_requests row at each PR
    // sync. A workspace whose checks only run on GitHub (no local check
    // script) used to sit on "Checks unknown" forever.
    expect(
      deriveWorkspacePrAction({ prNumber: 42, prState: "open", prChecks: "passing" }),
    ).toMatchObject({ title: "Checks passed", action: "merge", state: "ready" });
    expect(
      deriveWorkspacePrAction({ prNumber: 42, prState: "open", prChecks: "failing" }),
    ).toMatchObject({ title: "Checks failing", action: "view", state: "checks-failed" });
    expect(
      deriveWorkspacePrAction({ prNumber: 42, prState: "open", prChecks: "pending" }),
    ).toMatchObject({ title: "Checks running", action: "view", state: "checks-running" });
    // A finished local run is not a verdict and must not hide GitHub's: this
    // is what kept any workspace that had run its check script on "unknown".
    for (const checkStatus of ["exited", "stopped"]) {
      expect(
        deriveWorkspacePrAction({
          prNumber: 42,
          prState: "open",
          checkStatus,
          checkExitCode: 0,
          prChecks: "failing",
        }),
      ).toMatchObject({ title: "Checks failing", state: "checks-failed" });
    }
    // A live local check status still wins over the stored rollup.
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        checkStatus: "running",
        prChecks: "passing",
      }),
    ).toMatchObject({ state: "checks-running" });
  });

  it("reads the check tally from the summary, falling back to the row", () => {
    const counts = { total: 21, passed: 11, failed: 1, pending: 8, skipped: 1 };
    expect(
      deriveWorkspacePrAction(
        workspacePrActionInput(
          { prNumber: 42, prState: "open", prChecks: "failing", prCheckCounts: counts },
          undefined,
        ),
      ),
    ).toMatchObject({
      title: "Checks failing",
      detail: "11/20 passed, 1 failed, 8 running, 1 skipped",
    });
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        prChecks: "pending",
        prCheckCounts: { total: 20, passed: 12, failed: 0, pending: 8, skipped: 0 },
      }),
    ).toMatchObject({ title: "Checks running", detail: "12/20 passed, 8 running" });
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        prChecks: "passing",
        prCheckCounts: { total: 21, passed: 21, failed: 0, pending: 0, skipped: 0 },
      }),
    ).toMatchObject({ title: "Checks passed", detail: "21/21 passed", state: "ready" });
    // Behind base is still waiting on GitHub, so the tally still helps.
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        branchBehind: 1,
        prChecks: "passing",
        prCheckCounts: { total: 21, passed: 21, failed: 0, pending: 0, skipped: 0 },
      }),
    ).toMatchObject({ title: "Behind base", detail: "21/21 passed" });
    // The tally stays off states that are about local work.
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        conflicts: 1,
        prChecks: "passing",
        prCheckCounts: { total: 3, passed: 3, failed: 0, pending: 0, skipped: 0 },
      }).detail,
    ).toBeUndefined();
  });

  it("tells skipped or unrecognised checks apart from no checks at all", () => {
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        prCheckCounts: { total: 1, passed: 0, failed: 0, pending: 0, skipped: 1 },
      }),
    ).toMatchObject({ title: "Checks skipped", detail: "1 skipped", state: "checks-unknown" });
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        prCheckCounts: { total: 2, passed: 1, failed: 0, pending: 0, skipped: 0 },
      }),
    ).toMatchObject({ title: "Checks inconclusive", detail: "1/2 passed" });
    expect(deriveWorkspacePrAction({ prNumber: 42, prState: "open" })).toMatchObject({
      title: "No checks reported",
    });
  });

  it("does not render an open PR without checks as a question mark", () => {
    expect(WORKSPACE_PR_STATE_ICON["checks-unknown"]).not.toBe("circle-help");
    expect(deriveWorkspacePrAction({ prNumber: 42, prState: "open" })).toMatchObject({
      cssClass: "ws-pr-status-muted",
      state: "checks-unknown",
    });
  });

  it("routes explicit failed checks to review instead of merge", () => {
    for (const input of [{ checkStatus: "failed" }]) {
      expect(
        deriveWorkspacePrAction({
          prNumber: 42,
          prState: "open",
          ...input,
        }),
      ).toMatchObject({
        title: "Checks failing",
        actionLabel: "Fix Checks",
        action: "view",
      });
    }
  });

  it("does not treat local check process exits as revision-tied PR failures", () => {
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        checkStatus: "exited",
        checkExitCode: 7,
      }),
    ).toMatchObject({
      title: "No checks reported",
      actionLabel: "Review",
      action: "view",
    });
  });

  it("does not let stale failed checks override local PR changes", () => {
    for (const input of [
      { changedFiles: 1 },
      { branchAhead: 1 },
    ]) {
      expect(
        deriveWorkspacePrAction({
          prNumber: 42,
          prState: "open",
          checkStatus: "exited",
          checkExitCode: 7,
          ...input,
        }),
      ).toMatchObject({
        actionLabel: "Push",
        action: "push",
      });
    }
  });
});

describe("shouldSyncPullRequest", () => {
  it("keeps polling an open PR whatever the bar is showing", () => {
    expect(shouldSyncPullRequest({ prNumber: 42, prState: "open" })).toBe(true);
    expect(shouldSyncPullRequest({ prNumber: 42, prState: "OPEN" })).toBe(true);
  });

  it("looks for a PR opened outside Archductor while the branch has work", () => {
    // No PR row yet: only asking GitHub (by branch) finds one created with the
    // gh CLI or the web UI while this workspace stays open.
    expect(shouldSyncPullRequest({ additions: 3, deletions: 0 })).toBe(true);
    expect(shouldSyncPullRequest({ additions: 0, deletions: 2 })).toBe(true);
  });

  it("stays quiet when there is nothing to learn", () => {
    expect(shouldSyncPullRequest(undefined)).toBe(false);
    expect(shouldSyncPullRequest({ additions: 0, deletions: 0 })).toBe(false);
    expect(shouldSyncPullRequest({ prNumber: 42, prState: "merged", additions: 3 })).toBe(false);
    expect(shouldSyncPullRequest({ prNumber: 42, prState: "closed" })).toBe(false);
  });
});

// The state kind exists because the action kind collapses six distinct
// situations into `view`. These cases pin every branch to its own state, so a
// future edit cannot quietly re-merge them.
describe("deriveWorkspacePrAction state", () => {
  const OPEN = { prNumber: 42, prState: "open" };

  const CASES: Array<{ state: WorkspacePrStateKind; input: WorkspacePrActionInput }> = [
    { state: "no-changes", input: {} },
    { state: "no-pr", input: { changedFiles: 3 } },
    { state: "unpushed", input: { branchAhead: 2 } },
    { state: "merged", input: { ...OPEN, prState: "merged" } },
    { state: "closed", input: { ...OPEN, prState: "closed" } },
    { state: "conflict", input: { ...OPEN, conflicts: 1 } },
    { state: "uncommitted", input: { ...OPEN, changedFiles: 1 } },
    { state: "unpushed", input: { ...OPEN, branchAhead: 1 } },
    { state: "checks-failed", input: { ...OPEN, checkStatus: "failure" } },
    { state: "checks-running", input: { ...OPEN, checkStatus: "pending" } },
    { state: "checks-running", input: { ...OPEN, checkStatus: "queued" } },
    { state: "checks-running", input: { ...OPEN, checkStatus: "running" } },
    { state: "behind-base", input: { ...OPEN, branchBehind: 3 } },
    { state: "checks-unknown", input: { ...OPEN } },
    { state: "ready", input: { ...OPEN, checkStatus: "success" } },
  ];

  for (const { state, input } of CASES) {
    it(`reports ${state} for ${JSON.stringify(input)}`, () => {
      expect(deriveWorkspacePrAction(input).state).toBe(state);
    });
  }

  it("covers every declared state across the case table", () => {
    const declared = Object.keys(WORKSPACE_PR_STATE_ICON) as WorkspacePrStateKind[];
    const covered = new Set(CASES.map((c) => c.state));
    expect([...declared].sort()).toEqual([...covered].sort());
  });

  it("gives every state a distinct glyph, so no two read the same in the sidebar", () => {
    const icons = Object.values(WORKSPACE_PR_STATE_ICON);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("animates only states that are genuinely in flight or need a human", () => {
    // Motion is a scarce signal: if most rows move, movement stops meaning
    // anything. Keep the animated set small and deliberate.
    expect(Object.keys(WORKSPACE_PR_STATE_MOTION).sort()).toEqual([
      "checks-failed",
      "checks-running",
      "conflict",
    ]);
    expect(WORKSPACE_PR_STATE_MOTION["ready"]).toBeUndefined();
    expect(WORKSPACE_PR_STATE_MOTION["merged"]).toBeUndefined();
  });
});
