// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout, LayoutLeaf, LayoutNode, LayoutSplit } from "@/lib/layout";

function leaves(layout: Layout): LayoutLeaf[] {
  const list: LayoutLeaf[] = [];
  const walk = (node: LayoutNode) => {
    if (node.type === "leaf") {
      list.push(node);
      return;
    }
    walk(node.children[0]);
    walk(node.children[1]);
  };
  walk(layout.root);
  return list;
}

function leafHolding(layout: Layout, panelId: string): LayoutLeaf {
  const hit = leaves(layout).find((node) => node.panels.includes(panelId));
  if (!hit) throw new Error(`no leaf holds ${panelId}`);
  return hit;
}

describe("layoutStore", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("starts from an independent copy of the immutable Code preset", async () => {
    const { BUILTIN_PRESETS } = await import("@/lib/layoutPresets");
    const { layoutStore } = await import("./layout");

    expect(layoutStore.activePreset().id).toBe("code");
    expect(layoutStore.layout().version).toBe(2);
    expect(leafHolding(layoutStore.layout(), "chat").panels).toEqual(["chat"]);
    expect(layoutStore.layout()).not.toBe(BUILTIN_PRESETS[0].layout);

    leafHolding(layoutStore.layout(), "chat").panels.push("files");
    expect(leafHolding(BUILTIN_PRESETS[0].layout, "chat").panels).toEqual(["chat"]);
  });

  it("sanitizes unknown panels whenever a layout is applied", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { builtinPreset } = await import("@/lib/layoutPresets");
    const { layoutStore } = await import("./layout");
    const preset = builtinPreset("wide")!;
    leafHolding(preset.layout, "summary").panels.push("removed-by-future-build");

    layoutStore.applyLayout(preset);

    expect(layoutStore.activePreset().id).toBe("wide");
    expect(leafHolding(layoutStore.layout(), "summary").panels).toEqual([
      "summary",
      "files",
      "changes",
      "checks",
    ]);
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes("removed-by-future-build"),
      ),
    ).toHaveLength(1);
  });

  it("does not let applied or returned preset objects mutate built-ins", async () => {
    const { BUILTIN_PRESETS, builtinPreset } = await import("@/lib/layoutPresets");
    const { layoutStore } = await import("./layout");
    const preset = builtinPreset("review")!;

    layoutStore.applyLayout(preset);
    leafHolding(preset.layout, "changes").panels[0] = "chat";
    leafHolding(layoutStore.activePreset().layout, "changes").panels[0] = "files";

    expect(leafHolding(layoutStore.layout(), "changes").panels[0]).toBe("changes");
    expect(leafHolding(BUILTIN_PRESETS[2].layout, "changes").panels[0]).toBe("changes");
  });

  it("reveals a hidden panel, opens its leaf, activates it, and schedules focus", async () => {
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    vi.stubGlobal("document", { querySelector });
    const { layoutStore } = await import("./layout");
    const { actions } = await import("./actions");
    const host = leafHolding(layoutStore.layout(), "changes").id;
    layoutStore.removePanel("changes");
    layoutStore.setCollapsed(host, true);
    expect(layoutStore.hiddenPanels()).toContain("changes");

    actions.revealPanel("changes");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    const leaf = leafHolding(layoutStore.layout(), "changes");
    expect(leaf.collapsed).toBe(false);
    expect(leaf.panels[leaf.active]).toBe("changes");
    expect(querySelector).toHaveBeenCalledWith("[data-panel-id='changes']");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("applies a drop through the store and marks the preset edited", async () => {
    const { layoutStore } = await import("./layout");
    const edits: unknown[] = [];
    layoutStore.onEdited((preset) => edits.push(preset));
    const before = layoutStore.layout();
    const firstLeaf = (before.root.type === "leaf" ? before.root : before.root.children[0]) as { id: string };

    layoutStore.applyDrop({ kind: "split", leafId: firstLeaf.id, edge: "bottom" }, "checks");

    expect(edits.length).toBeGreaterThan(0);
    expect(layoutStore.layout()).not.toEqual(before);
    layoutStore.onEdited(undefined);
  });

  it("tracks edit mode", async () => {
    const { layoutStore } = await import("./layout");
    expect(layoutStore.editing()).toBe(false);
    layoutStore.setEditing(true);
    expect(layoutStore.editing()).toBe(true);
    layoutStore.setEditing(false);
  });

  it("adds, removes, collapses, and resizes through the tree transforms", async () => {
    const { layoutStore } = await import("./layout");
    const target = leafHolding(layoutStore.layout(), "chat").id;

    layoutStore.addPanel("todos", target);
    expect(leafHolding(layoutStore.layout(), "chat").panels).toEqual(["chat", "todos"]);

    layoutStore.removePanel("todos");
    expect(layoutStore.hiddenPanels()).toContain("todos");

    layoutStore.setCollapsed(target, true);
    expect(leafHolding(layoutStore.layout(), "chat").collapsed).toBe(true);

    const split = layoutStore.layout().root as LayoutSplit;
    layoutStore.setRatio(split.id, 0.4);
    expect((layoutStore.layout().root as LayoutSplit).ratio).toBeCloseTo(0.4);
  });

  it("refuses to collapse the last open leaf", async () => {
    const { layoutStore } = await import("./layout");
    for (const leaf of leaves(layoutStore.layout())) layoutStore.setCollapsed(leaf.id, true);

    expect(leaves(layoutStore.layout()).filter((leaf) => !leaf.collapsed)).toHaveLength(1);
  });

  it("cycles visible tabs in tree order and wraps past both ends", async () => {
    vi.stubGlobal("document", { querySelector: vi.fn(() => null) });
    const { layoutStore } = await import("./layout");
    // Hardcoded, not derived from visiblePanelIds(), which is the function
    // cyclePanel walks internally — deriving the expectation from it would
    // only restate the implementation. This is the Code tree's leaf order:
    // chat | pr | summary, files, changes, checks.
    layoutStore.setFocusedLeaf(leafHolding(layoutStore.layout(), "chat").id);

    // Seven forward steps from "chat" walk all six tabs and wrap onto a second
    // lap, so the end-of-list boundary is actually crossed.
    const forward = Array.from({ length: 7 }, () => layoutStore.cyclePanel(1));
    expect(forward).toEqual(["pr", "summary", "files", "changes", "checks", "chat", "pr"]);

    // Backward off the front of the list wraps to the last tab.
    const backward = Array.from({ length: 3 }, () => layoutStore.cyclePanel(-1));
    expect(backward).toEqual(["chat", "checks", "changes"]);
  });

  it("forks an immutable built-in once before arrangement edits", async () => {
    const { layoutStore } = await import("./layout");

    layoutStore.removePanel("files");
    const forkId = layoutStore.activePreset().id;
    expect(layoutStore.activePreset()).toMatchObject({ builtin: false, name: "Code (edited)" });
    expect(forkId).toMatch(/^custom-/);

    layoutStore.removePanel("summary");
    expect(layoutStore.activePreset().id).toBe(forkId);
  });

  it("keeps the active tab inside the leaf after hiding the active panel", async () => {
    const { layoutStore } = await import("./layout");
    const before = leafHolding(layoutStore.layout(), "changes");
    expect(before.panels[before.active]).toBe("changes");

    layoutStore.removePanel("changes");

    const after = leafHolding(layoutStore.layout(), "checks");
    expect(after.panels).toEqual(["summary", "files", "checks"]);
    expect(after.active).toBe(2);
  });

  it("toggles the side panel leaf rather than a named region", async () => {
    const { layoutStore } = await import("./layout");
    expect(layoutStore.sidePanelCollapsed()).toBe(false);

    layoutStore.toggleSidePanel();
    expect(layoutStore.sidePanelCollapsed()).toBe(true);

    layoutStore.toggleSidePanel();
    expect(layoutStore.sidePanelCollapsed()).toBe(false);
  });
});
