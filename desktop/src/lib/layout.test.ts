import { describe, expect, it } from "vitest";
import {
  activatePanel,
  addPanel,
  applyDrop,
  cloneLayout,
  eachLeaf,
  findLeaf,
  isLayout,
  leaf,
  leafCount,
  removePanel,
  setCollapsed,
  setRatio,
  split,
  visiblePanelIds,
  type Drop,
  type Layout,
  type LayoutLeaf,
  type LayoutSplit,
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
