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

  it("does not take pointer capture until the drag threshold is crossed", () => {
    // Capturing on pointerdown — before it's known whether this is a drag or
    // a click — makes Chromium retarget the click it synthesizes on
    // pointerup to the capturing element: dead tab switches, dead "Hide",
    // dead "Collapse" in edit mode, all from the same cause. jsdom does not
    // implement that retargeting (see the render-level test in
    // PanelDnd.render.test.tsx for the explicit note), so this asserts the
    // fix at the level jsdom actually can: capture must not exist before
    // `move()` latches `dragging`.
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const capture = { setPointerCapture, releasePointerCapture } as never;
    const controller = createPanelDragController({
      applyDrop: vi.fn(),
      measureLeaves: () => [],
      requestFrame: (run) => (run(0), 0),
    });

    controller.begin({ panelId: "chat", clientX: 0, clientY: 0, pointerId: 1, captureTarget: capture });
    expect(setPointerCapture).not.toHaveBeenCalled();

    controller.move({ clientX: 2, clientY: 0 });
    expect(setPointerCapture).not.toHaveBeenCalled();

    controller.move({ clientX: 9, clientY: 0 });
    expect(setPointerCapture).toHaveBeenCalledTimes(1);
    expect(setPointerCapture).toHaveBeenCalledWith(1);

    controller.cancel();
    expect(releasePointerCapture).toHaveBeenCalledTimes(1);
  });

  it("never calls releasePointerCapture for a gesture that never crossed the threshold", () => {
    // Release semantics are otherwise unchanged, but release is now
    // conditional on capture actually having been taken — a plain click
    // (pointerdown, pointerup, no drag) must not call it at all.
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const capture = { setPointerCapture, releasePointerCapture } as never;
    const controller = createPanelDragController({
      applyDrop: vi.fn(),
      measureLeaves: () => [],
      requestFrame: (run) => (run(0), 0),
    });

    controller.begin({ panelId: "chat", clientX: 0, clientY: 0, pointerId: 1, captureTarget: capture });
    controller.move({ clientX: 1, clientY: 0 });
    controller.end();

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(releasePointerCapture).not.toHaveBeenCalled();
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
