// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { layoutStore } from "@/store/layout";
import { hiddenPanelControls, layoutPresetControls } from "@/lib/layoutControls";
import { BUILTIN_PRESETS, builtinPreset } from "@/lib/layoutPresets";

describe("LayoutControls", () => {
  beforeEach(() => {
    layoutStore.resetToCode();
  });

  it("offers every hidden panel through accessible restore controls", () => {
    const labels = hiddenPanelControls(layoutStore.hiddenPanels()).map((control) => control.ariaLabel);
    // The Code tree no longer carries a terminal dock — with regions gone the
    // terminal is an ordinary panel, hidden until it is added to a leaf.
    expect(labels).toEqual([
      "Restore Terminal",
      "Restore Todos",
      "Restore Checkpoints",
      "Restore Processes",
      "Restore Timeline",
      "Restore Context",
    ]);
  });

  it("marks built-ins as locked and exposes the active project default", () => {
    const user = builtinPreset("wide")!;
    user.id = "custom-wide";
    user.name = "Team wide";
    user.builtin = false;

    expect(layoutPresetControls([...BUILTIN_PRESETS, user], "custom-wide", "custom-wide"))
      .toEqual([
        { id: "code", label: "Code (built-in, locked)", active: false, locked: true },
        { id: "wide", label: "Wide (built-in, locked)", active: false, locked: true },
        { id: "review", label: "Review (built-in, locked)", active: false, locked: true },
        { id: "watch", label: "Watch (built-in, locked)", active: false, locked: true },
        {
          id: "custom-wide",
          label: "Team wide (project default)",
          active: true,
          locked: false,
        },
      ]);
  });
});
