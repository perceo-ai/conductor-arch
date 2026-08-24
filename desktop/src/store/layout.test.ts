// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("layoutStore", () => {
  beforeEach(() => vi.resetModules());

  it("starts from an independent copy of the immutable Code preset", async () => {
    const { BUILTIN_PRESETS } = await import("@/lib/layoutPresets");
    const { layoutStore } = await import("./layout");

    expect(layoutStore.activePreset().id).toBe("code");
    expect(layoutStore.layout().regions.center.panels).toEqual(["chat"]);
    expect(layoutStore.layout()).not.toBe(BUILTIN_PRESETS[0].layout);

    layoutStore.layout().regions.center.panels.push("files");
    expect(BUILTIN_PRESETS[0].layout.regions.center.panels).toEqual(["chat"]);
  });

  it("overlays device-local region sizes and collapsed regions", async () => {
    const { prefsStore } = await import("./prefs");
    prefsStore.setRegionSize("left", 340);
    prefsStore.setRegionSize("right", 410);
    prefsStore.setRegionCollapsed("left", true);

    const { layoutStore } = await import("./layout");
    expect(layoutStore.layout().regions.left).toMatchObject({ size: 340, collapsed: true });
    expect(layoutStore.layout().regions.right).toMatchObject({ size: 410, collapsed: false });
    expect(layoutStore.layout().regions.center.collapsed).toBe(false);
  });

  it("sanitizes unknown panels whenever a layout is applied", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { builtinPreset } = await import("@/lib/layoutPresets");
    const { layoutStore } = await import("./layout");
    const preset = builtinPreset("wide")!;
    preset.layout.regions.right.panels.push("removed-by-future-build");

    layoutStore.applyLayout(preset);

    expect(layoutStore.activePreset().id).toBe("wide");
    expect(layoutStore.layout().regions.right.panels).toEqual(["summary", "changes", "checks"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not let applied or returned preset objects mutate built-ins", async () => {
    const { BUILTIN_PRESETS, builtinPreset } = await import("@/lib/layoutPresets");
    const { layoutStore } = await import("./layout");
    const preset = builtinPreset("review")!;

    layoutStore.applyLayout(preset);
    preset.layout.regions.center.panels[0] = "chat";
    layoutStore.activePreset().layout.regions.center.panels[0] = "files";

    expect(layoutStore.layout().regions.center.panels).toEqual(["changes"]);
    expect(BUILTIN_PRESETS[2].layout.regions.center.panels).toEqual(["changes"]);
  });
});
