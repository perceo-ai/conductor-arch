import { describe, expect, it } from "vitest";
import { cloneLayout, eachLeaf, findLeaf, isLayout, leaf, split, visiblePanelIds, type Layout } from "./layout";

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
