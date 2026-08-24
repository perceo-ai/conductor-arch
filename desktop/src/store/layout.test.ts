// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("layoutStore", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

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
    expect(
      warn.mock.calls.filter(
        ([message]) => message === "[layout] Dropped unknown panel id: removed-by-future-build",
      ),
    ).toHaveLength(1);
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

  it("reveals a hidden panel, opens its region, activates tabs, and schedules focus", async () => {
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    vi.stubGlobal("document", { querySelector });
    const { collapseRegion, hidePanel } = await import("@/lib/layout");
    const { layoutStore } = await import("./layout");
    const { actions } = await import("./actions");
    layoutStore.mutate((layout) => collapseRegion(hidePanel(layout, "changes"), "right", true));

    actions.revealPanel("changes");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(layoutStore.layout().regions.right).toMatchObject({
      panels: ["summary", "files", "checks", "changes"],
      active: 3,
      collapsed: false,
    });
    expect(querySelector).toHaveBeenCalledWith("[data-panel-id='changes']");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("reveals strips and docks without changing the active tab", async () => {
    const { hidePanel } = await import("@/lib/layout");
    const { layoutStore } = await import("./layout");
    const { actions } = await import("./actions");
    layoutStore.mutate((layout) => hidePanel(hidePanel(layout, "pr"), "terminal"));

    actions.revealPanel("pr");
    actions.revealPanel("terminal");

    expect(layoutStore.layout().regions.right.strips).toEqual(["pr"]);
    expect(layoutStore.layout().regions.right.docks).toEqual(["terminal"]);
    expect(layoutStore.layout().regions.right.active).toBe(2);
  });

  it("cycles only visible tabs in region order and wraps both directions", async () => {
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    const { movePanel } = await import("@/lib/layout");
    const { layoutStore } = await import("./layout");
    layoutStore.mutate((layout) => {
      let next = movePanel(layout, "files", "left", 0);
      next = movePanel(next, "checks", "bottom", 0);
      return next;
    });
    layoutStore.setFocusedRegion("right");

    expect(layoutStore.cyclePanel(1)).toBe("checks");
    expect(layoutStore.focusedRegion()).toBe("bottom");
    expect(layoutStore.cyclePanel(1)).toBe("files");
    expect(layoutStore.cyclePanel(-1)).toBe("checks");
  });

  it("forks an immutable built-in once before arrangement edits", async () => {
    const { layoutStore } = await import("./layout");

    layoutStore.hidePanel("files");
    const forkId = layoutStore.activePreset().id;
    expect(layoutStore.activePreset()).toMatchObject({ builtin: false, name: "Code (edited)" });
    expect(forkId).toMatch(/^custom-/);

    layoutStore.movePanel("summary", "left", 0);
    expect(layoutStore.activePreset().id).toBe(forkId);
  });

  it("keeps the centre usable and picks the nearest tab after hiding the active tab", async () => {
    const { layoutStore } = await import("./layout");
    layoutStore.hidePanel("changes");
    expect(layoutStore.layout().regions.right.panels).toEqual(["summary", "files", "checks"]);
    expect(layoutStore.layout().regions.right.active).toBe(2);

    layoutStore.hidePanel("chat");
    layoutStore.collapseRegion("center", true);
    expect(layoutStore.layout().regions.center).toMatchObject({ panels: ["chat"], collapsed: false });
  });

  it("persists region sizes and collapses as device preferences", async () => {
    const { layoutStore } = await import("./layout");
    const { prefsStore } = await import("./prefs");

    layoutStore.resizeRegion("left", 360);
    layoutStore.collapseRegion("left", true);

    expect(layoutStore.layout().regions.left).toMatchObject({ size: 360, collapsed: true });
    expect(prefsStore.state.regionSizes.left).toBe(360);
    expect(prefsStore.state.collapsedRegions).toContain("left");
  });
});
