import { describe, expect, it } from "vitest";
import { PRODUCT_RIGHT_PANEL_TABS, rightPanelTabLabel } from "./rightPanelTabs";

describe("right panel product tabs", () => {
  it("matches the strategy tab order without exposing internal runtime tabs", () => {
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).toEqual([
      "tasks",
      "summary",
      "files",
      "changes",
      "checks",
      "context",
      "review",
      "pr",
    ]);
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.label)).toEqual([
      "Tasks",
      "Summary",
      "Files",
      "Changes",
      "Checks",
      "Context",
      "Review",
      "PR",
    ]);
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("checkpoints");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("processes");
  });

  it("falls back to Summary for unknown persisted tab values", () => {
    expect(rightPanelTabLabel("summary")).toBe("Summary");
    expect(rightPanelTabLabel("processes")).toBe("Summary");
  });
});
