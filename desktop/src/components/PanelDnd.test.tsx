// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPanelDragController, measureRenderedLeaves } from "./PanelDndController";
import type { LeafRect } from "@/lib/layout";

function pointer(type: string, x: number, y: number) {
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
}

function leafRect(id: string, over: Partial<LeafRect> = {}): LeafRect {
  return {
    leafId: id,
    rect: { left: 0, top: 0, width: 400, height: 400 },
    tabBarHeight: 30,
    tabs: [],
    ...over,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("PanelDnd controller", () => {
  it("keeps movement below 4px as a click and starts at 4px", () => {
    const applyDrop = vi.fn();
    const controller = createPanelDragController({
      applyDrop,
      measureLeaves: () => [leafRect("a")],
      requestFrame: (run) => (run(0), 1),
    });
    controller.begin({ panelId: "changes", clientX: 10, clientY: 10, pointerId: 1, captureTarget: document.body });
    window.dispatchEvent(pointer("pointermove", 13, 10));
    expect(controller.state()?.dragging).toBe(false);
    window.dispatchEvent(pointer("pointermove", 14, 10));
    expect(controller.state()?.dragging).toBe(true);
    window.dispatchEvent(pointer("pointerup", 14, 10));
    expect(applyDrop).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("commits the resolved drop and previews it while dragging", () => {
    const applyDrop = vi.fn();
    const controller = createPanelDragController({
      applyDrop,
      measureLeaves: () => [leafRect("a")],
      requestFrame: (run) => (run(0), 1),
    });
    controller.begin({ panelId: "chat", clientX: 0, clientY: 200, pointerId: 1, captureTarget: document.body });
    window.dispatchEvent(pointer("pointermove", 380, 200));

    expect(controller.state()?.drop).toEqual({ kind: "split", leafId: "a", edge: "right" });
    expect(controller.state()?.preview).toEqual({ left: 200, top: 0, width: 200, height: 400 });

    window.dispatchEvent(pointer("pointerup", 380, 200));
    expect(applyDrop).toHaveBeenCalledWith({ kind: "split", leafId: "a", edge: "right" }, "chat");
    controller.dispose();
  });

  it("cancels on Escape and drops nothing outside every leaf", () => {
    const applyDrop = vi.fn();
    const controller = createPanelDragController({
      applyDrop,
      measureLeaves: () => [leafRect("a")],
      requestFrame: (run) => (run(0), 1),
    });
    controller.begin({ panelId: "changes", clientX: 10, clientY: 10, pointerId: 1, captureTarget: document.body });
    window.dispatchEvent(pointer("pointermove", 200, 200));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.dispatchEvent(pointer("pointerup", 200, 200));
    expect(applyDrop).not.toHaveBeenCalled();
    expect(controller.state()).toBeNull();

    const outside = createPanelDragController({
      applyDrop,
      measureLeaves: () => [],
      requestFrame: (run) => (run(0), 1),
    });
    outside.begin({ panelId: "changes", clientX: 10, clientY: 10, pointerId: 1, captureTarget: document.body });
    window.dispatchEvent(pointer("pointermove", 900, 900));
    window.dispatchEvent(pointer("pointerup", 900, 900));
    expect(applyDrop).not.toHaveBeenCalled();

    controller.dispose();
    outside.dispose();
  });

  it("removes every window listener after drop and dispose", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const controller = createPanelDragController({
      applyDrop: vi.fn(),
      measureLeaves: () => [],
      requestFrame: (run) => (run(0), 1),
    });
    controller.begin({ panelId: "changes", clientX: 0, clientY: 0, pointerId: 1, captureTarget: document.body });
    window.dispatchEvent(pointer("pointerup", 0, 0));
    controller.dispose();

    for (const type of ["pointermove", "pointerup", "pointercancel", "keydown"]) {
      expect(add.mock.calls.some(([event]) => event === type)).toBe(true);
      expect(remove.mock.calls.some(([event]) => event === type)).toBe(true);
    }
  });

  it("measures leaves from PanelLeaf's DOM contract", () => {
    // The tab bar's height is measured, never assumed: `resolveDrop` uses it as
    // the boundary between "insert as a tab" and "split this leaf".
    const leaf = document.createElement("section");
    leaf.dataset.leafId = "leaf-1";
    leaf.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 }) as DOMRect;
    const bar = document.createElement("div");
    bar.setAttribute("data-tab-bar", "");
    bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 28 }) as DOMRect;
    const tab = document.createElement("div");
    tab.dataset.tabIndex = "0";
    tab.getBoundingClientRect = () => ({ left: 4, top: 0, width: 70, height: 24 }) as DOMRect;
    bar.append(tab);
    leaf.append(bar);
    document.body.append(leaf);

    expect(measureRenderedLeaves()).toEqual([
      {
        leafId: "leaf-1",
        rect: { left: 0, top: 0, width: 300, height: 200 },
        tabBarHeight: 28,
        tabs: [{ left: 4, width: 70 }],
      },
    ]);
  });
});
