import { describe, expect, it } from "vitest";
import {
  PRODUCT_RIGHT_PANEL_TABS,
  normalizeRightPanelTab,
  rightPanelTabLabel,
} from "./rightPanelTabs";

describe("right panel product tabs", () => {
  it("orders the combined human context tab before file tabs", () => {
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).toEqual([
      "summary",
      "files",
      "changes",
      "checks",
    ]);
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.label)).toEqual([
      "Summary",
      "Files",
      "Changes",
      "Checks",
    ]);
    // Tasks and todos live inside Summary; they are not peer tabs.
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("tasks");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("context");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("checkpoints");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("processes");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("pr");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("review");
  });

  it("falls back to summary for removed or unknown tabs", () => {
    expect(rightPanelTabLabel("summary")).toBe("Summary");
    expect(rightPanelTabLabel("changes")).toBe("Changes");
    expect(rightPanelTabLabel("processes")).toBe("Summary");
    expect(rightPanelTabLabel("pr")).toBe("Summary");
    expect(rightPanelTabLabel("review")).toBe("Summary");
    expect(normalizeRightPanelTab("summary")).toBe("summary");
    expect(normalizeRightPanelTab("files")).toBe("files");
    expect(normalizeRightPanelTab("tasks")).toBe("summary");
    expect(normalizeRightPanelTab("nonsense")).toBe("summary");
  });
});
