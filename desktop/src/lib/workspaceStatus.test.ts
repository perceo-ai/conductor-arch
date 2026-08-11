// @vitest-environment node
import { describe, expect, it } from "vitest";
import { workspaceStatusKind, STATUS_COLOR, STATUS_LABEL } from "./workspaceStatus";

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

  it("changes when only uncommitted edits exist", () => {
    expect(workspaceStatusKind({ changedFiles: 3 })).toBe("changes");
  });

  it("idle when nothing is in flight", () => {
    expect(workspaceStatusKind({ status: "active" })).toBe("idle");
  });

  it("every kind has a color and label", () => {
    for (const k of ["running", "review", "changes", "idle", "archived"] as const) {
      expect(STATUS_COLOR[k]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(STATUS_LABEL[k]).toBeTruthy();
    }
  });
});
