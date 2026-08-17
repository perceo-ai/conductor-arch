import { describe, expect, it } from "vitest";
import { deriveWorkspacePrAction } from "./workspacePrAction";

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

  it("moves open clean PRs to merge when checks are clear", () => {
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

  it("routes failed checks to review instead of merge", () => {
    expect(
      deriveWorkspacePrAction({
        prNumber: 42,
        prState: "open",
        checkStatus: "failed",
      }),
    ).toMatchObject({
      title: "Checks failing",
      actionLabel: "Fix Checks",
      action: "view",
    });
  });
});
