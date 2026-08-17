// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  dashboardTriageBadges,
  workspaceSidebarMeta,
  workspaceStatusKind,
  STATUS_COLOR,
  STATUS_LABEL,
} from "./workspaceStatus";

describe("workspaceStatusKind", () => {
  it("archived wins over everything", () => {
    expect(
      workspaceStatusKind({ status: "archived", runRunning: true, changedFiles: 5 }),
    ).toBe("archived");
  });

  it("running when a session is active or run is live", () => {
    expect(workspaceStatusKind({ status: "active", runRunning: true })).toBe("running");
    expect(workspaceStatusKind({ status: "active", activeSessions: 2 })).toBe("running");
  });

  it("review when an open PR exists and nothing is running", () => {
    expect(workspaceStatusKind({ prNumber: 12, prState: "open" })).toBe("review");
    // closed PR does not count
    expect(workspaceStatusKind({ prNumber: 12, prState: "closed", changedFiles: 1 })).toBe(
      "changes",
    );
  });

  it("blocked when a task is blocked, ahead of running/review/changes", () => {
    expect(
      workspaceStatusKind({ status: "active", blockedTasks: 1, runRunning: true, changedFiles: 4 }),
    ).toBe("blocked");
    // archived still wins
    expect(workspaceStatusKind({ status: "archived", blockedTasks: 2 })).toBe("archived");
    // open tasks alone are not blocking
    expect(workspaceStatusKind({ status: "active", openTasks: 3 })).toBe("idle");
  });

  it("changes when only uncommitted edits exist", () => {
    expect(workspaceStatusKind({ changedFiles: 3 })).toBe("changes");
  });

  it("idle when nothing is in flight", () => {
    expect(workspaceStatusKind({ status: "active" })).toBe("idle");
  });

  it("every kind has a color and label", () => {
    for (const k of ["blocked", "running", "review", "changes", "idle", "archived"] as const) {
      expect(STATUS_COLOR[k]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(STATUS_LABEL[k]).toBeTruthy();
    }
  });
});

describe("dashboardTriageBadges", () => {
  it("summarizes active agents, run status, PR state, changed files, and todos", () => {
    expect(
      dashboardTriageBadges({
        activeSessions: 2,
        runRunning: true,
        prNumber: 93,
        prState: "open",
        changedFiles: 4,
        openTodos: 1,
      }),
    ).toEqual([
      { tone: "agent", label: "2 agents", title: "2 active agent sessions" },
      { tone: "run", label: "Run live", title: "Run script is running" },
      { tone: "pr", label: "PR #93 open", title: "Pull request #93 is open" },
      { tone: "changes", label: "4 files", title: "4 changed files" },
      { tone: "todo", label: "1 todo", title: "1 open todo" },
    ]);
  });

  it("surfaces blocked tasks ahead of the PR badge", () => {
    expect(
      dashboardTriageBadges({
        activeSessions: 0,
        runRunning: false,
        openTasks: 3,
        blockedTasks: 1,
        prNumber: 12,
        prState: "open",
        changedFiles: 0,
        openTodos: 0,
      }),
    ).toEqual([
      { tone: "agent", label: "No agents", title: "No active agent sessions" },
      { tone: "run", label: "Run idle", title: "No run script is running" },
      { tone: "task", label: "1 blocked", title: "1 blocked task of 3 open tasks" },
      { tone: "pr", label: "PR #12 open", title: "Pull request #12 is open" },
      { tone: "changes", label: "Clean", title: "No changed files" },
      { tone: "todo", label: "No todos", title: "No open todos" },
    ]);
  });

  it("keeps clean and idle workspace badges compact", () => {
    expect(
      dashboardTriageBadges({
        activeSessions: 0,
        runRunning: false,
        changedFiles: 0,
        openTodos: 0,
      }),
    ).toEqual([
      { tone: "agent", label: "No agents", title: "No active agent sessions" },
      { tone: "run", label: "Run idle", title: "No run script is running" },
      { tone: "changes", label: "Clean", title: "No changed files" },
      { tone: "todo", label: "No todos", title: "No open todos" },
    ]);
  });
});

describe("workspaceSidebarMeta", () => {
  it("summarizes branch and diff as one quiet line", () => {
    expect(
      workspaceSidebarMeta({
        status: "active",
        branch: "feature/chat-first",
        additions: 274,
        deletions: 33,
        activeSessions: 2,
        openTasks: 5,
        prNumber: 93,
        prState: "open",
      }),
    ).toBe("feature/chat-first · +274 -33");
  });

  it("falls back to status when there is no branch or diff", () => {
    expect(workspaceSidebarMeta({ status: "archived" })).toBe("archived");
  });
});
