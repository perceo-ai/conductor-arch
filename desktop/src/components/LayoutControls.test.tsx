// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { layoutStore } from "@/store/layout";
import { hiddenPanelControls } from "@/lib/layoutControls";

describe("LayoutControls", () => {
  beforeEach(() => {
    layoutStore.resetToCode();
  });

  it("offers every hidden panel through accessible restore controls", () => {
    const labels = hiddenPanelControls(layoutStore.hiddenPanels()).map((control) => control.ariaLabel);
    expect(labels).toEqual([
      "Restore Todos",
      "Restore Checkpoints",
      "Restore Processes",
      "Restore Timeline",
      "Restore Context",
    ]);
  });
});
