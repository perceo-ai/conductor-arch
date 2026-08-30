// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

// The clamp is the only decision in this component that is not visible in the
// DOM, so it is spied on rather than inferred. Everything else is asserted
// against the emitted markup.
vi.mock("@/lib/panelWidths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/panelWidths")>();
  return { ...actual, clampSplitRatio: vi.fn(actual.clampSplitRatio) };
});

import { leaf, split, type LayoutNode } from "@/lib/layout";
import { registerPanel, unregisterPanel } from "@/lib/panelRegistry";
import { layoutStore } from "@/store/layout";
import {
  PANEL_MIN_HEIGHT_PX,
  PANEL_MIN_PX,
  clampSplitRatio,
  COLLAPSED_HEADER_PX,
  COLLAPSED_RAIL_PX,
} from "@/lib/panelWidths";
import LayoutNodeView from "./LayoutNodeView";

const clampSpy = vi.mocked(clampSplitRatio);

// jsdom performs no layout, so clientWidth/clientHeight are 0 and the component
// would skip clamping entirely. Pin them to a known box for the whole file.
const SPLIT_WIDTH = 1000;
const SPLIT_HEIGHT = 800;
const original = {
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
};
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get: () => SPLIT_WIDTH,
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => SPLIT_HEIGHT,
});
afterAll(() => {
  if (original.width) Object.defineProperty(HTMLElement.prototype, "clientWidth", original.width);
  if (original.height) Object.defineProperty(HTMLElement.prototype, "clientHeight", original.height);
});

// Panels with distinct, known minimums on each axis, so "max over this child's
// panels" is provable rather than coincidental.
const PANELS = {
  wide: { id: "lnv-wide", width: 300, height: 90 },
  wider: { id: "lnv-wider", width: 500, height: 60 },
  narrow: { id: "lnv-narrow", width: 240, height: 200 },
};

let dispose: (() => void) | undefined;

beforeEach(() => {
  for (const panel of Object.values(PANELS)) {
    registerPanel({
      id: panel.id,
      title: panel.id,
      icon: "file-text",
      kind: "tab",
      component: () => <div>{panel.id} body</div>,
      requiresWorkspace: true,
    });
    PANEL_MIN_PX[panel.id] = panel.width;
    PANEL_MIN_HEIGHT_PX[panel.id] = panel.height;
  }
  clampSpy.mockClear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  for (const panel of Object.values(PANELS)) {
    unregisterPanel(panel.id);
    delete PANEL_MIN_PX[panel.id];
    delete PANEL_MIN_HEIGHT_PX[panel.id];
  }
  layoutStore.setEditing(false);
});

function mount(node: LayoutNode) {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <LayoutNodeView node={node} workspace="demo" />, host);
  return host;
}

const flexOf = (host: HTMLElement, index: 0 | 1) =>
  host.querySelectorAll<HTMLElement>(".workbench-split > .workbench-split-child")[index].style.flex;

describe("LayoutNodeView", () => {
  it("renders a leaf directly and a split as two leaves around a handle", () => {
    const only = mount(leaf([PANELS.wide.id], { id: "solo" }));
    expect([...only.querySelectorAll("[data-leaf-id]")].map((el) => el.getAttribute("data-leaf-id")))
      .toEqual(["solo"]);
    expect(only.querySelector(".workbench-split")).toBeNull();
    dispose?.();
    dispose = undefined;
    document.body.innerHTML = "";

    const host = mount(
      split("row", leaf([PANELS.wide.id], { id: "a" }), leaf([PANELS.wider.id], { id: "b" }), 0.4),
    );

    const container = host.querySelector<HTMLElement>(".workbench-split")!;
    expect(container.dataset.direction).toBe("row");
    expect([...host.querySelectorAll("[data-leaf-id]")].map((el) => el.getAttribute("data-leaf-id")))
      .toEqual(["a", "b"]);
    // Resizing is a structural edit like drag, split, collapse, close, and
    // add — the handle exists only inside edit mode (see LayoutNodeView.tsx),
    // not as a permanently-present-but-dimmed divider.
    expect(host.querySelectorAll(".resize-handle-split")).toHaveLength(0);
  });

  it("renders the resize handle only in edit mode", () => {
    const host = mount(
      split("row", leaf([PANELS.wide.id], { id: "a" }), leaf([PANELS.wider.id], { id: "b" }), 0.4),
    );
    expect(host.querySelectorAll(".resize-handle-split")).toHaveLength(0);

    layoutStore.setEditing(true);
    expect(host.querySelectorAll(".resize-handle-split")).toHaveLength(1);

    layoutStore.setEditing(false);
    expect(host.querySelectorAll(".resize-handle-split")).toHaveLength(0);
  });

  it("gives the first child the stored ratio and the second the remainder", () => {
    // 1000px wide, minimums 300 and 500: 0.4 is inside [0.3, 0.5] and survives.
    const host = mount(
      split("row", leaf([PANELS.wide.id], { id: "a" }), leaf([PANELS.wider.id], { id: "b" }), 0.4),
    );

    expect(flexOf(host, 0)).toBe("0.4 1 0%");
    expect(flexOf(host, 1)).toBe("0.6 1 0%");
  });

  it("clamps with (available, ratio, firstMin, secondMin), maxed over each child's panels", () => {
    // First child holds two panels: its minimum is the larger of the two.
    mount(
      split(
        "row",
        leaf([PANELS.narrow.id, PANELS.wide.id], { id: "a" }),
        leaf([PANELS.wider.id], { id: "b" }),
        0.4,
      ),
    );

    expect(clampSpy).toHaveBeenCalled();
    expect(clampSpy.mock.calls[0]).toEqual([SPLIT_WIDTH, 0.4, PANELS.wide.width, PANELS.wider.width]);
  });

  it("clamps a column against the height table, not the width table", () => {
    // The width table would say 300/240; the height table says 90/200. Using
    // widths here is what overrode the Code and Review presets' 0.12 strip.
    mount(
      split("column", leaf([PANELS.wide.id], { id: "a" }), leaf([PANELS.narrow.id], { id: "b" }), 0.15),
    );

    expect(clampSpy.mock.calls[0]).toEqual([
      SPLIT_HEIGHT,
      0.15,
      PANELS.wide.height,
      PANELS.narrow.height,
    ]);
  });

  it("clamps a ratio that would starve a child below its minimum", () => {
    // 1000px, second child needs 500: the first may take at most 0.5.
    const host = mount(
      split("row", leaf([PANELS.wide.id], { id: "a" }), leaf([PANELS.wider.id], { id: "b" }), 0.9),
    );

    expect(flexOf(host, 0)).toBe("0.5 1 0%");
    expect(flexOf(host, 1)).toBe("0.5 1 0%");
  });

  it("pins a collapsed child to a fixed rail in a row and a header in a column", () => {
    // `flex: 0 0 auto` in a row resolves to the tab strip's max-content width
    // and cannot shrink back, so the collapsed pane never actually collapses.
    const row = mount(
      split(
        "row",
        leaf([PANELS.wide.id], { id: "a", collapsed: true }),
        leaf([PANELS.wider.id], { id: "b" }),
        0.4,
      ),
    );
    expect(flexOf(row, 0)).toBe(`0 0 ${COLLAPSED_RAIL_PX}px`);
    expect(flexOf(row, 1)).toBe("1 1 0%");
    expect(row.querySelectorAll(".workbench-split-child-collapsed")).toHaveLength(1);
    dispose?.();
    dispose = undefined;
    document.body.innerHTML = "";

    const column = mount(
      split(
        "column",
        leaf([PANELS.wide.id], { id: "a" }),
        leaf([PANELS.wider.id], { id: "b", collapsed: true }),
        0.4,
      ),
    );
    expect(column.querySelector<HTMLElement>(".workbench-split")!.dataset.direction).toBe("column");
    expect(flexOf(column, 0)).toBe("1 1 0%");
    expect(flexOf(column, 1)).toBe(`0 0 ${COLLAPSED_HEADER_PX}px`);
  });

  it("hides the resize handle while a child is collapsed, even in edit mode", () => {
    // The ratio drives nothing in this state, so a drag would fork the preset
    // and schedule a save with nothing visibly changing. Edit mode alone is
    // not enough to show it — collapse still wins.
    layoutStore.setEditing(true);
    const host = mount(
      split(
        "row",
        leaf([PANELS.wide.id], { id: "a", collapsed: true }),
        leaf([PANELS.wider.id], { id: "b" }),
        0.4,
      ),
    );

    expect(host.querySelector(".resize-handle-split")).toBeNull();
  });

  it("recurses through nested splits", () => {
    const host = mount(
      split(
        "row",
        leaf([PANELS.wide.id], { id: "a" }),
        split("column", leaf([PANELS.wider.id], { id: "b" }), leaf([PANELS.narrow.id], { id: "c" }), 0.3),
        0.6,
      ),
    );

    expect([...host.querySelectorAll("[data-leaf-id]")].map((el) => el.getAttribute("data-leaf-id")))
      .toEqual(["a", "b", "c"]);
    expect([...host.querySelectorAll<HTMLElement>(".workbench-split")].map((el) => el.dataset.direction))
      .toEqual(["row", "column"]);
  });
});
