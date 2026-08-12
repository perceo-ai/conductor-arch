import { describe, expect, it } from "vitest";
import { deriveWorkspaceBriefing } from "./workspaceBriefing";

describe("deriveWorkspaceBriefing", () => {
  it("prioritizes live agent work over review tasks", () => {
    const briefing = deriveWorkspaceBriefing(
      {
        activeSessions: 2,
        runRunning: false,
        changedFiles: 3,
        openTodos: 1,
        additions: 10,
        deletions: 2,
      },
      {
        active_sessions: 2,
        open_review_comments: 4,
        conflicting_workspaces: 0,
        check_status: "failure",
      },
    );

    expect(briefing.topbarSummary).toBe("2 agents active");
    expect(briefing.nextAction).toBe("Watch agent output and steer when needed");
    expect(briefing.tiles.find((tile) => tile.label === "Checks")?.value).toBe("Failing");
  });

  it("surfaces review blockers before generic PR readiness", () => {
    const briefing = deriveWorkspaceBriefing(
      {
        prNumber: 93,
        prState: "open",
        changedFiles: 0,
        openTodos: 0,
        activeSessions: 0,
        runRunning: false,
      },
      {
        active_sessions: 0,
        pull_request_number: 93,
        pull_request_state: "open",
        open_review_comments: 2,
        conflicting_workspaces: 0,
        check_status: "success",
      },
    );

    expect(briefing.nextAction).toBe("Resolve 2 review comments");
    expect(briefing.tiles.find((tile) => tile.label === "Review")?.tone).toBe("danger");
  });

  it("guides changed workspaces without a pull request toward review and publish", () => {
    const briefing = deriveWorkspaceBriefing(
      {
        changedFiles: 5,
        additions: 42,
        deletions: 7,
        activeSessions: 0,
        runRunning: false,
      },
      undefined,
    );

    expect(briefing.topbarSummary).toBe("5 changed files");
    expect(briefing.nextAction).toBe("Review changes, then push or open a PR");
    expect(briefing.tiles.find((tile) => tile.label === "Changes")?.value).toBe(
      "5 files · +42 -7",
    );
  });
});
