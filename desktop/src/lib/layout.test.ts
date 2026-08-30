import { describe, expect, it } from "vitest";
import {
  activatePanel,
  addPanel,
  applyDrop,
  cloneLayout,
  codeFallback,
  dropPreviewRect,
  eachLeaf,
  findLeaf,
  isLayout,
  leaf,
  leafCount,
  removePanel,
  resolveDrop,
  sanitizeLayout,
  setCollapsed,
  setRatio,
  split,
  visiblePanelIds,
  type Drop,
  type Layout,
  type LayoutLeaf,
  type LayoutSplit,
  type LeafRect,
} from "./layout";

describe("layout tree", () => {
  it("builds leaves and splits with stable ids and defaults", () => {
    const a = leaf(["chat"]);
    const b = leaf(["files", "changes"], { active: 1, display: "compact" });
    const root = split("row", a, b, 0.6);

    expect(a.type).toBe("leaf");
    expect(a.active).toBe(0);
    expect(a.display).toBe("tabs");
    expect(a.collapsed).toBe(false);
    expect(b.active).toBe(1);
    expect(b.display).toBe("compact");
    expect(root.direction).toBe("row");
    expect(root.ratio).toBe(0.6);
    expect(root.children).toHaveLength(2);
    // Ids are unique and non-empty.
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThan(0);
  });

  it("defaults a split ratio to an even share", () => {
    expect(split("column", leaf(["chat"]), leaf(["files"])).ratio).toBe(0.5);
  });

  it("walks and finds leaves", () => {
    const a = leaf(["chat"]);
    const b = leaf(["files"]);
    const c = leaf(["terminal"]);
    const root = split("row", a, split("column", b, c));

    const seen: string[] = [];
    eachLeaf(root, (node) => seen.push(node.panels[0]));
    expect(seen).toEqual(["chat", "files", "terminal"]);
    expect(findLeaf(root, b.id)).toBe(b);
    expect(findLeaf(root, "nope")).toBeUndefined();
  });

  it("clones deeply so edits cannot alias the original", () => {
    const original: Layout = { version: 2, root: split("row", leaf(["chat"]), leaf(["files"])) };
    const copy = cloneLayout(original);
    (copy.root as ReturnType<typeof split>).ratio = 0.9;

    expect((original.root as ReturnType<typeof split>).ratio).toBe(0.5);
    expect(copy).not.toBe(original);
  });

  it("accepts a well-formed v2 layout and rejects everything else", () => {
    expect(isLayout({ version: 2, root: leaf(["chat"]) })).toBe(true);
    expect(isLayout({ version: 1, regions: {} })).toBe(false);
    expect(isLayout({ version: 2, root: { type: "split", id: "x", direction: "row", children: [leaf(["chat"])], ratio: 0.5 } })).toBe(false);
    expect(isLayout({ version: 2, root: { type: "split", id: "x", direction: "diagonal", children: [leaf(["a"]), leaf(["b"])], ratio: 0.5 } })).toBe(false);
    expect(isLayout({ version: 2, root: { type: "leaf", id: "x", panels: ["a"], active: 0, display: "tabs", collapsed: false, extra: 1 } })).toBe(true);
    expect(isLayout(null)).toBe(false);
  });

  it("lists visible panels in tree order", () => {
    const layout: Layout = { version: 2, root: split("row", leaf(["chat"]), split("column", leaf(["pr"]), leaf(["files", "changes"]))) };
    expect(visiblePanelIds(layout)).toEqual(["chat", "pr", "files", "changes"]);
  });
});

function twoPane() {
  const left = leaf(["chat"]);
  const right = leaf(["files", "changes"], { active: 1 });
  return { left, right, layout: { version: 2, root: split("row", left, right, 0.6) } as Layout };
}

describe("tree transforms", () => {
  it("moves a panel into another leaf as a tab at an index", () => {
    const { left, layout } = twoPane();
    const drop: Drop = { kind: "tab", leafId: left.id, index: 0 };

    const next = applyDrop(layout, drop, "changes");

    expect(visiblePanelIds(next)).toEqual(["changes", "chat", "files"]);
    expect(leafCount(next)).toBe(2);
  });

  it("splits a leaf on an edge, placing the panel on that side", () => {
    const { right, layout } = twoPane();

    const next = applyDrop(layout, { kind: "split", leafId: right.id, edge: "bottom" }, "chat");

    // chat left its leaf; that leaf held only chat, so it collapsed away.
    expect(leafCount(next)).toBe(2);
    expect(visiblePanelIds(next)).toEqual(["files", "changes", "chat"]);
    const root = next.root as LayoutSplit;
    expect(root.type).toBe("split");
    expect(root.direction).toBe("column");
    expect((root.children[1] as LayoutLeaf).panels).toEqual(["chat"]);
  });

  it("places a left or top edge drop before the target", () => {
    const { right, layout } = twoPane();

    const next = applyDrop(layout, { kind: "split", leafId: right.id, edge: "left" }, "chat");

    const root = next.root as LayoutSplit;
    expect(root.direction).toBe("row");
    expect((root.children[0] as LayoutLeaf).panels).toEqual(["chat"]);
  });

  it("is a no-op when a panel is dropped on the leaf it already occupies", () => {
    const { right, layout } = twoPane();

    const next = applyDrop(layout, { kind: "tab", leafId: right.id, index: 0 }, "files");

    expect(visiblePanelIds(next)).toEqual(["chat", "files", "changes"]);
    expect(leafCount(next)).toBe(2);
  });

  it("removes an emptied leaf and collapses its parent split into the sibling", () => {
    const { layout } = twoPane();

    const next = removePanel(layout, "chat");

    expect(next.root.type).toBe("leaf");
    expect(visiblePanelIds(next)).toEqual(["files", "changes"]);
    expect(leafCount(next)).toBe(1);
  });

  it("refuses to remove the last panel in the layout", () => {
    const only: Layout = { version: 2, root: leaf(["chat"]) };
    expect(removePanel(only, "chat")).toBe(only);
  });

  it("keeps the active index inside the panel list after a removal", () => {
    const { right, layout } = twoPane();

    const next = removePanel(layout, "changes");

    expect(findLeaf(next.root, right.id)!.active).toBe(0);
  });

  it("adds a hidden panel to a named leaf, or the first leaf by default", () => {
    const { left, layout } = twoPane();

    expect(visiblePanelIds(addPanel(layout, "todos", left.id))).toEqual(["chat", "todos", "files", "changes"]);
    expect(visiblePanelIds(addPanel(layout, "todos"))).toEqual(["chat", "todos", "files", "changes"]);
    // Already present: unchanged.
    expect(addPanel(layout, "chat")).toBe(layout);
  });

  it("is a no-op when addPanel targets a leaf id that does not exist", () => {
    const { layout } = twoPane();
    expect(addPanel(layout, "todos", "bogus-leaf-id")).toBe(layout);
  });

  it("collapses a leaf but never the last uncollapsed one", () => {
    const { left, right, layout } = twoPane();

    const one = setCollapsed(layout, left.id, true);
    expect(findLeaf(one.root, left.id)!.collapsed).toBe(true);

    const two = setCollapsed(one, right.id, true);
    expect(two).toBe(one);
  });

  it("is a no-op when setCollapsed targets a leaf id that does not exist", () => {
    const { layout } = twoPane();
    expect(setCollapsed(layout, "bogus-leaf-id", true)).toBe(layout);
    expect(setCollapsed(layout, "bogus-leaf-id", false)).toBe(layout);
  });

  it("clamps a split ratio away from the edges", () => {
    const { layout } = twoPane();
    const id = (layout.root as LayoutSplit).id;

    expect((setRatio(layout, id, 0.42).root as LayoutSplit).ratio).toBeCloseTo(0.42);
    expect((setRatio(layout, id, 0).root as LayoutSplit).ratio).toBeGreaterThan(0);
    expect((setRatio(layout, id, 1).root as LayoutSplit).ratio).toBeLessThan(1);
  });

  it("is a no-op when setRatio targets a split id that does not exist", () => {
    const { layout } = twoPane();
    expect(setRatio(layout, "bogus-split-id", 0.3)).toBe(layout);
  });

  it("activatePanel focuses an already-placed panel and uncollapses its leaf", () => {
    const { right, layout } = twoPane();
    const collapsedLayout = setCollapsed(layout, right.id, true);

    const next = activatePanel(collapsedLayout, "files");

    const focused = findLeaf(next.root, right.id)!;
    expect(focused.collapsed).toBe(false);
    expect(focused.active).toBe(0);
  });

  it("activatePanel places an absent panel and uncollapses its destination leaf", () => {
    const { left, layout } = twoPane();
    const collapsedLayout = setCollapsed(layout, left.id, true);

    const next = activatePanel(collapsedLayout, "todos");

    const destination = findLeaf(next.root, left.id)!;
    expect(destination.panels).toContain("todos");
    expect(destination.collapsed).toBe(false);
    expect(destination.active).toBe(destination.panels.indexOf("todos"));
  });
});

function rect(id: string, over: Partial<LeafRect> = {}): LeafRect {
  return {
    leafId: id,
    rect: { left: 0, top: 0, width: 400, height: 400 },
    tabBarHeight: 30,
    tabs: [],
    ...over,
  };
}

describe("resolveDrop", () => {
  it("returns null when the pointer is outside every leaf", () => {
    expect(resolveDrop([rect("a")], { x: 900, y: 900 })).toBeNull();
  });

  it("insert-as-tab when the pointer is over the tab bar", () => {
    const leafRect = rect("a", { tabs: [{ left: 0, width: 100 }, { left: 100, width: 100 }] });
    expect(resolveDrop([leafRect], { x: 40, y: 10 })).toEqual({ kind: "tab", leafId: "a", index: 0 });
    expect(resolveDrop([leafRect], { x: 380, y: 10 })).toEqual({ kind: "tab", leafId: "a", index: 2 });
  });

  it("distinguishes insert-before from insert-after within the same tab", () => {
    // Same two tabs as above: [0,100) and [100,200). The index is a splice
    // point, not "which tab is under the cursor" — the left and right
    // halves of tab 1 must resolve to different indices, or there would be
    // no pointer position that inserts after the last tab.
    const leafRect = rect("a", { tabs: [{ left: 0, width: 100 }, { left: 100, width: 100 }] });
    // x: 140 is the left half of tab 1 (midpoint 150) -> insert before it.
    expect(resolveDrop([leafRect], { x: 140, y: 10 })).toEqual({ kind: "tab", leafId: "a", index: 1 });
    // x: 160 is the right half of tab 1 -> insert after it.
    expect(resolveDrop([leafRect], { x: 160, y: 10 })).toEqual({ kind: "tab", leafId: "a", index: 2 });
  });

  it("appends as a tab in the centre zone", () => {
    expect(resolveDrop([rect("a")], { x: 200, y: 200 })).toEqual({ kind: "tab", leafId: "a", index: 0 });
  });

  it("splits on the nearest edge by fraction, not pixels", () => {
    // 800x200 leaf, 30px tab bar (content height 170). Fractions below are
    // x/width and (y - tabBarHeight)/contentHeight.
    const wide = rect("a", { rect: { left: 0, top: 0, width: 800, height: 200 } });
    // (20,50): x is 2.5% across; y is (50-30)/170 ~= 11.8% into the content.
    // Left is nearer as a fraction, so a left split wins.
    expect(resolveDrop([wide], { x: 20, y: 50 })).toEqual({ kind: "split", leafId: "a", edge: "left" });
    // (400,45): x is dead centre (50%); y is (45-30)/170 ~= 8.8% into the
    // content. Top is the only edge near enough, so top wins.
    expect(resolveDrop([wide], { x: 400, y: 45 })).toEqual({ kind: "split", leafId: "a", edge: "top" });
    // (780,100): x is 97.5% across (2.5% from the right); y is (100-30)/170
    // ~= 41.2% into the content, past the centre-zone threshold. Right wins.
    expect(resolveDrop([wide], { x: 780, y: 100 })).toEqual({ kind: "split", leafId: "a", edge: "right" });
    // (400,195): x is dead centre; y is (195-30)/170 ~= 97.1% into the
    // content, i.e. 2.9% from the bottom. Bottom wins.
    expect(resolveDrop([wide], { x: 400, y: 195 })).toEqual({ kind: "split", leafId: "a", edge: "bottom" });
  });

  it("computes the vertical fraction against content height, not full leaf height", () => {
    // Same 800x200 leaf, 30px tab bar. y=60 is 30% down the FULL leaf height
    // (outside the centre zone under a full-height formula, which would
    // append as a tab) but only (60-30)/170 ~= 17.6% into the CONTENT height
    // (inside the top zone). The content-relative formula is the one the
    // spec calls for, so this must resolve to a top split, not a tab append.
    const wide = rect("a", { rect: { left: 0, top: 0, width: 800, height: 200 } });
    expect(resolveDrop([wide], { x: 400, y: 60 })).toEqual({ kind: "split", leafId: "a", edge: "top" });
  });

  it("breaks an exact tie between axes in favour of the horizontal edge", () => {
    // Default 400x400 leaf, 30px tab bar (content height 370). Pick x and y
    // so the fractional distance to the nearest edge is exactly equal on
    // both axes: x=40 -> fx=0.1; y=67 -> (67-30)/370=0.1. Both are inside
    // the centre-zone threshold (0.25), so this is a real tie, not a
    // one-axis-only case, and the rule says horizontal wins.
    expect(resolveDrop([rect("a")], { x: 40, y: 67 })).toEqual({ kind: "split", leafId: "a", edge: "left" });
  });

  it("offers no split on an axis too small to divide", () => {
    const narrow = rect("a", { rect: { left: 0, top: 0, width: 90, height: 400 } });
    // Far left, but the leaf is only 90px wide: fall back to a tab.
    expect(resolveDrop([narrow], { x: 4, y: 200 })).toEqual({ kind: "tab", leafId: "a", index: 0 });
    // The vertical axis is still wide enough to split.
    expect(resolveDrop([narrow], { x: 45, y: 390 })).toEqual({ kind: "split", leafId: "a", edge: "bottom" });
  });

  it("previews the rectangle the panel will occupy", () => {
    const leafRect = rect("a");
    expect(dropPreviewRect(leafRect, { kind: "split", leafId: "a", edge: "left" }))
      .toEqual({ left: 0, top: 0, width: 200, height: 400 });
    expect(dropPreviewRect(leafRect, { kind: "split", leafId: "a", edge: "right" }))
      .toEqual({ left: 200, top: 0, width: 200, height: 400 });
    expect(dropPreviewRect(leafRect, { kind: "split", leafId: "a", edge: "top" }))
      .toEqual({ left: 0, top: 0, width: 400, height: 200 });
    expect(dropPreviewRect(leafRect, { kind: "split", leafId: "a", edge: "bottom" }))
      .toEqual({ left: 0, top: 200, width: 400, height: 200 });
    // A tab drop fills the leaf's content area, below the tab bar.
    expect(dropPreviewRect(leafRect, { kind: "tab", leafId: "a", index: 0 }))
      .toEqual({ left: 0, top: 30, width: 400, height: 370 });
  });
});

describe("sanitizeLayout v2", () => {
  it("returns the Code fallback for a v1 layout", () => {
    const v1 = { version: 1, regions: { left: {}, center: {}, bottom: {}, right: {} } };
    expect(sanitizeLayout(v1)).toEqual(sanitizeLayout(null));
    expect(sanitizeLayout(v1).version).toBe(2);
    expect(visiblePanelIds(sanitizeLayout(v1))).toContain("chat");
  });

  it("drops unknown panel ids", () => {
    const layout = { version: 2, root: leaf(["chat", "not-a-panel"]) };
    expect(visiblePanelIds(sanitizeLayout(layout))).toEqual(["chat"]);
  });

  it("keeps only the first occurrence of a duplicated panel", () => {
    const layout: Layout = { version: 2, root: split("row", leaf(["chat"]), leaf(["chat", "files"])) };
    expect(visiblePanelIds(sanitizeLayout(layout))).toEqual(["chat", "files"]);
  });

  it("prunes leaves emptied by sanitising and collapses their splits", () => {
    const layout: Layout = { version: 2, root: split("row", leaf(["ghost"]), leaf(["chat"])) };
    const next = sanitizeLayout(layout);
    expect(next.root.type).toBe("leaf");
    expect(visiblePanelIds(next)).toEqual(["chat"]);
  });

  it("falls back when sanitising empties the whole tree", () => {
    expect(visiblePanelIds(sanitizeLayout({ version: 2, root: leaf(["ghost"]) }))).toContain("chat");
  });

  it("clamps ratios and active indices", () => {
    const layout: Layout = { version: 2, root: split("row", leaf(["chat"], { active: 9 }), leaf(["files"]), 5) };
    const next = sanitizeLayout(layout);
    const root = next.root as LayoutSplit;
    expect(root.ratio).toBeLessThan(1);
    expect(root.ratio).toBeGreaterThan(0);
    expect((root.children[0] as LayoutLeaf).active).toBe(0);
  });

  it("leaves at least one leaf uncollapsed", () => {
    const layout: Layout = { version: 2, root: leaf(["chat"], { collapsed: true }) };
    expect((sanitizeLayout(layout).root as LayoutLeaf).collapsed).toBe(false);
  });

  it("returns a fresh clone each time, not the shared fallback constant", () => {
    const first = codeFallback();
    const second = codeFallback();
    expect(first).toEqual(second);

    (first.root as LayoutSplit).ratio = 0.99;
    (first.root as LayoutSplit).children[0] = leaf(["mutated"]);

    expect((second.root as LayoutSplit).ratio).toBe(0.62);
    expect(visiblePanelIds(second)).not.toContain("mutated");
    // A third call must also be unaffected by the mutation above.
    expect(codeFallback()).toEqual(second);
  });
});
