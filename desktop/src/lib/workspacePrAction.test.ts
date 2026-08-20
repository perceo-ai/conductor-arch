import { describe, expect, it } from "vitest";
import { deriveWorkspacePrAction, workspacePrActionInput } from "./workspacePrAction";

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
