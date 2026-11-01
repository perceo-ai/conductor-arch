// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { dropIndex } from "./WorkspacePanes";

// Three 100px tabs at x=0,100,200. jsdom lays nothing out, so the rects are
// stubbed per element.
function strip(names: string[]): HTMLElement {
  const host = document.createElement("div");
  names.forEach((name, i) => {
    const tab = document.createElement("div");
    tab.dataset.workspaceTab = name;
    tab.getBoundingClientRect = () =>
      ({ left: i * 100, width: 100, right: i * 100 + 100, top: 0, bottom: 30, height: 30, x: i * 100, y: 0, toJSON: () => ({}) }) as DOMRect;
    host.append(tab);
  });
  return host;
}

describe("dropIndex", () => {
  it("counts positions without the dragged tab, so a rightward drop lands where the pointer is", () => {
    // Dragging "a" between b and c (pointer at 180): kept tabs are [b, c],
    // and 180 is past b's midpoint (150) but before c's (250) → index 1,
    // which moveTab turns into [b, a, c].
    expect(dropIndex(strip(["a", "b", "c"]), 180, "a")).toBe(1);
    // Same pointer counting the dragged tab was index 2 → [b, c, a].
  });

  it("drops at the ends and from another strip unchanged", () => {
    expect(dropIndex(strip(["a", "b", "c"]), 10, "c")).toBe(0);
    expect(dropIndex(strip(["a", "b", "c"]), 990, "a")).toBe(2);
    // Cross-group: dragged tab is not in this strip; all three count.
    expect(dropIndex(strip(["a", "b", "c"]), 180, "zz")).toBe(2);
  });
});
