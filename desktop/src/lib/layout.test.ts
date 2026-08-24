// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  activatePanel,
  collapseRegion,
  dropTarget,
  hidePanel,
  movePanel,
  resizeRegion,
  sanitizeLayout,
  showPanel,
  type Layout,
} from "./layout";
import { registerPanel, unregisterPanel } from "./panelRegistry";

function stack(overrides: Partial<Layout["regions"]["right"]> = {}) {
  return { panels: [], strips: [], docks: [], active: 0, size: 0, collapsed: false, ...overrides };
}

function layout(): Layout {
  return {
    version: 1,
    regions: {
      left: stack({ size: 260 }),
      center: stack({ panels: ["chat"], size: 0 }),
      bottom: stack({ size: 280 }),
      right: stack({ strips: ["pr"], panels: ["summary", "files", "changes", "checks"], docks: ["terminal"], active: 2, size: 300 }),
    },
  };
}

describe("layout", () => {
  it("moves a panel by removing its old occurrence first", () => {
    const next = movePanel(layout(), "changes", "left", 0);
    expect(next.regions.right.panels).toEqual(["summary", "files", "checks"]);
    expect(next.regions.left.panels).toEqual(["changes"]);
  });

  it("rejects a panel in a region it does not allow", () => {
    const current = layout();
    registerPanel({
      id: "right-only",
      title: "Right only",
      icon: "panel-right",
      kind: "tab",
      component: () => null,
      regions: ["right"],
      defaultRegion: "right",
      requiresWorkspace: true,
    });
    expect(movePanel(current, "right-only", "bottom", 0)).toBe(current);
    unregisterPanel("right-only");
  });

  it("routes every move to its descriptor kind list", () => {
    const next = movePanel(layout(), "changes", "right", 0);
    expect(next.regions.right.strips).toEqual(["pr"]);
    expect(next.regions.right.docks).toEqual(["terminal"]);
    expect(next.regions.right.panels).toEqual(["changes", "summary", "files", "checks"]);
    const dock = movePanel(layout(), "terminal", "bottom", 0);
    expect(dock.regions.bottom.panels).toEqual([]);
    expect(dock.regions.bottom.docks).toEqual(["terminal"]);
  });

  it("rejects moving the final centre tab out", () => {
    const current = layout();
    expect(movePanel(current, "chat", "right", 0)).toBe(current);
  });

  it("rejects moving the final centre dock out", () => {
    const current = layout();
    current.regions.center.panels = [];
    current.regions.center.docks = ["terminal"];
    current.regions.right.docks = [];
    expect(movePanel(current, "terminal", "bottom", 0)).toBe(current);
  });

  it("rejects hiding the final centre tab when no dock remains", () => {
    const current = layout();
    expect(hidePanel(current, "chat")).toBe(current);
  });

  it("repairs the active index after hiding a tab", () => {
    const next = hidePanel(layout(), "changes");
    expect(next.regions.right.panels).toEqual(["summary", "files", "checks"]);
    expect(next.regions.right.active).toBe(2);
  });

  it("shows a hidden panel in its descriptor default region", () => {
    const next = showPanel(layout(), "todos");
    expect(next.regions.right.panels).toEqual(["summary", "files", "changes", "checks", "todos"]);
  });

  it("activation reveals and expands the panel region", () => {
    const current = layout();
    current.regions.right.collapsed = true;
    const next = activatePanel(hidePanel(current, "changes"), "changes");
    expect(next.regions.right.collapsed).toBe(false);
    expect(next.regions.right.panels).toContain("changes");
    expect(next.regions.right.active).toBe(3);
  });

  it("clamps all resizable region sizes", () => {
    expect(resizeRegion(layout(), "left", 100).regions.left.size).toBe(220);
    expect(resizeRegion(layout(), "right", 999).regions.right.size).toBe(440);
    expect(resizeRegion(layout(), "bottom", 100).regions.bottom.size).toBe(160);
    expect(resizeRegion(layout(), "bottom", 999).regions.bottom.size).toBe(560);
  });

  it("collapses a region without changing its contents", () => {
    const next = collapseRegion(layout(), "right", true);
    expect(next.regions.right.collapsed).toBe(true);
    expect(next.regions.right.panels).toEqual(layout().regions.right.panels);
  });

  it("rejects collapsing the centre region", () => {
    const current = layout();
    expect(collapseRegion(current, "center", true)).toBe(current);
  });

  it("normalizes a persisted collapsed centre to visible", () => {
    const current = layout();
    current.regions.center.collapsed = true;
    expect(sanitizeLayout(current).regions.center.collapsed).toBe(false);
  });

  it("sanitizes unknown, duplicate, and wrong-kind panel ids", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const current = layout();
    current.regions.left.panels = ["files", "missing", "pr"];
    current.regions.right.panels = ["files", "terminal", "changes"];
    current.regions.right.strips = ["pr", "changes"];
    current.regions.right.docks = ["terminal", "chat"];
    const next = sanitizeLayout(current);
    expect(next.regions.left.panels).toEqual(["files"]);
    expect(next.regions.right.panels).toEqual(["changes"]);
    expect(next.regions.right.strips).toEqual(["pr"]);
    expect(next.regions.right.docks).toEqual(["terminal"]);
    expect(warn).toHaveBeenCalledWith("[layout] Dropped unknown panel id: missing");
    warn.mockRestore();
  });

  it("logs an unknown panel only once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const current = layout();
    current.regions.left.panels = ["future-panel"];
    sanitizeLayout(current);
    sanitizeLayout(current);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[layout] Dropped unknown panel id: future-panel");
    warn.mockRestore();
  });

  it("falls back to a fresh Code layout for corrupt stored input", () => {
    const fallback = sanitizeLayout({ version: 1, regions: null });
    expect(fallback).toMatchObject({
      version: 1,
      regions: {
        center: { panels: ["chat"] },
        right: { strips: ["pr"], panels: ["summary", "files", "changes", "checks"], docks: ["terminal"], active: 2 },
      },
    });
    fallback.regions.center.panels.push("files");
    expect(sanitizeLayout(null).regions.center.panels).toEqual(["chat"]);
  });

  it("calculates tab drop positions at before, between, and after midpoints", () => {
    const regions = [
      { region: "right" as const, allowed: true, tabs: [{ left: 100, width: 60 }, { left: 160, width: 80 }] },
    ];
    expect(dropTarget(regions, { x: 110, y: 0 })).toEqual({ region: "right", index: 0 });
    expect(dropTarget(regions, { x: 150, y: 0 })).toEqual({ region: "right", index: 1 });
    expect(dropTarget(regions, { x: 210, y: 0 })).toEqual({ region: "right", index: 2 });
  });

  it("does not offer a drop target in a disallowed region", () => {
    expect(dropTarget([{ region: "bottom", allowed: false, tabs: [] }], { x: 5, y: 0 })).toBeNull();
  });

  it("selects only the allowed region under the pointer", () => {
    const regions = [
      { region: "left" as const, allowed: true, rect: { left: 0, top: 0, width: 100, height: 100 }, tabs: [] },
      { region: "bottom" as const, allowed: true, rect: { left: 0, top: 100, width: 200, height: 100 }, tabs: [{ left: 0, width: 60 }] },
    ];
    expect(dropTarget(regions, { x: 80, y: 150 })).toEqual({ region: "bottom", index: 1 });
    expect(dropTarget(regions, { x: 240, y: 150 })).toBeNull();
  });
});
