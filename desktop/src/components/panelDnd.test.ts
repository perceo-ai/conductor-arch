import { describe, expect, it, vi } from "vitest";
import { createPanelDragController } from "./PanelDndController";

describe("panel drag controller", () => {
  it("does not begin a drag until the pointer passes the threshold", () => {
    const applyDrop = vi.fn();
    const states: unknown[] = [];
    const controller = createPanelDragController({ applyDrop, onState: (s) => states.push(s), requestFrame: (run) => (run(0), 0) });
    const capture = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() } as never;

    controller.begin({ panelId: "chat", clientX: 0, clientY: 0, pointerId: 1, captureTarget: capture });
    controller.move({ clientX: 2, clientY: 0 });
    expect(states.at(-1)).toMatchObject({ dragging: false });

    controller.move({ clientX: 9, clientY: 0 });
    expect(states.at(-1)).toMatchObject({ dragging: true });
    controller.cancel();
  });

  it("commits the resolved drop on release and clears state", () => {
    const applyDrop = vi.fn();
    const controller = createPanelDragController({
      applyDrop,
      measureLeaves: () => [{ leafId: "a", rect: { left: 0, top: 0, width: 400, height: 400 }, tabBarHeight: 30, tabs: [] }],
      requestFrame: (run) => (run(0), 0),
    });
    const capture = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() } as never;

    controller.begin({ panelId: "chat", clientX: 0, clientY: 0, pointerId: 1, captureTarget: capture });
    controller.move({ clientX: 380, clientY: 200 });
    controller.end();

    expect(applyDrop).toHaveBeenCalledWith({ kind: "split", leafId: "a", edge: "right" }, "chat");
    expect(controller.state()).toBeNull();
  });

  it("cancels without applying anything", () => {
    const applyDrop = vi.fn();
    const controller = createPanelDragController({ applyDrop, measureLeaves: () => [], requestFrame: (run) => (run(0), 0) });
    const capture = { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() } as never;

    controller.begin({ panelId: "chat", clientX: 0, clientY: 0, pointerId: 1, captureTarget: capture });
    controller.move({ clientX: 200, clientY: 200 });
    controller.cancel();

    expect(applyDrop).not.toHaveBeenCalled();
    expect(controller.state()).toBeNull();
  });
});
