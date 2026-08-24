// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPanelDragController } from "./PanelDndController";
import { registerPanel, unregisterPanel } from "@/lib/panelRegistry";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function region(box: DOMRect, tabs: Array<DOMRect> = []) {
  const element = document.createElement("section");
  element.getBoundingClientRect = () => box;
  for (const box of tabs) {
    const tab = document.createElement("button");
    tab.dataset.panelKind = "tab";
    tab.getBoundingClientRect = () => box;
    element.append(tab);
  }
  document.body.append(element);
  return element;
}

function pointer(type: string, x: number, y: number) {
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  unregisterPanel("right-only-drag");
});

describe("PanelDnd controller", () => {
  it("keeps movement below 4px as a click and starts at 4px", () => {
    const movePanel = vi.fn();
    const controller = createPanelDragController({ movePanel, requestFrame: (run) => (run(0), 1) });
    controller.registerRegion("right", region(rect(0, 0, 100, 100)));
    controller.begin({ panelId: "changes", clientX: 10, clientY: 10, pointerId: 1, captureTarget: document.body });
    window.dispatchEvent(pointer("pointermove", 13, 10));
    expect(controller.state()?.dragging).toBe(false);
    window.dispatchEvent(pointer("pointermove", 14, 10));
    expect(controller.state()?.dragging).toBe(true);
    window.dispatchEvent(pointer("pointerup", 14, 10));
    expect(movePanel).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("commits the literal caret index only in an allowed region", () => {
    const movePanel = vi.fn();
    const controller = createPanelDragController({ movePanel, requestFrame: (run) => (run(0), 1) });
    controller.registerRegion("right", region(rect(0, 0, 100, 100)));
    controller.registerRegion("bottom", region(rect(0, 100, 200, 100), [rect(0, 100, 50, 30), rect(50, 100, 50, 30)]));
    controller.begin({ panelId: "changes", clientX: 10, clientY: 10, pointerId: 1, captureTarget: document.body });
    window.dispatchEvent(pointer("pointermove", 75, 150));
    window.dispatchEvent(pointer("pointerup", 75, 150));
    expect(movePanel).toHaveBeenCalledWith("changes", "bottom", 2);
    controller.dispose();
  });

  it("cancels on Escape and ignores disallowed drops", () => {
    registerPanel({
      id: "right-only-drag",
      title: "Right only",
      icon: "panel-right",
      kind: "tab",
      component: () => null,
      regions: ["right"],
      defaultRegion: "right",
      requiresWorkspace: true,
    });
    const movePanel = vi.fn();
    const controller = createPanelDragController({ movePanel, requestFrame: (run) => (run(0), 1) });
    controller.registerRegion("bottom", region(rect(0, 100, 200, 100)));
    controller.begin({ panelId: "right-only-drag", clientX: 10, clientY: 10, pointerId: 1, captureTarget: document.body });
    window.dispatchEvent(pointer("pointermove", 20, 150));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.dispatchEvent(pointer("pointerup", 20, 150));
    expect(movePanel).not.toHaveBeenCalled();
    expect(controller.state()).toBeNull();
    controller.dispose();
  });

  it("removes every window listener after drop and dispose", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const controller = createPanelDragController({ movePanel: vi.fn(), requestFrame: (run) => (run(0), 1) });
    controller.begin({ panelId: "changes", clientX: 0, clientY: 0, pointerId: 1, captureTarget: document.body });
    window.dispatchEvent(pointer("pointerup", 0, 0));
    controller.dispose();

    for (const type of ["pointermove", "pointerup", "pointercancel", "keydown"]) {
      expect(add.mock.calls.some(([event]) => event === type)).toBe(true);
      expect(remove.mock.calls.some(([event]) => event === type)).toBe(true);
    }
  });
});
