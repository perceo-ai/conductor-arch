import { describe, expect, it } from "vitest";
import { PRODUCT_RIGHT_PANEL_TABS, rightPanelTabLabel } from "./rightPanelTabs";

describe("right panel product tabs", () => {
  it("keeps the inspector focused on review surfaces", () => {
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).toEqual([
      "files",
      "changes",
      "checks",
    ]);
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.label)).toEqual([
      "Files",
      "Changes",
      "Checks",
    ]);
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("tasks");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("summary");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("context");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("checkpoints");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("processes");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("pr");
    expect(PRODUCT_RIGHT_PANEL_TABS.map((tab) => tab.id)).not.toContain("review");
  });

  it("falls back to Changes for demoted or unknown persisted tab values", () => {
    expect(rightPanelTabLabel("changes")).toBe("Changes");
    expect(rightPanelTabLabel("summary")).toBe("Changes");
    expect(rightPanelTabLabel("processes")).toBe("Changes");
    expect(rightPanelTabLabel("pr")).toBe("Changes");
    expect(rightPanelTabLabel("review")).toBe("Changes");
  });
});
