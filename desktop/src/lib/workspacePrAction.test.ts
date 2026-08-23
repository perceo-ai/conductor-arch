import { describe, expect, it } from "vitest";
import {
  WORKSPACE_PR_STATE_ICON,
  WORKSPACE_PR_STATE_MOTION,
  deriveWorkspacePrAction,
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

  it("does not treat a local successful check process as full merge readiness", () => {
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        checkStatus: "exited",
        checkExitCode: 0,
      }),
    ).toMatchObject({
      title: "Checks unknown",
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
      title: "Ready to merge",
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
        title: "Checks unknown",
        actionLabel: "Review",
        action: "view",
      });
    }
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
      title: "Checks unknown",
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
