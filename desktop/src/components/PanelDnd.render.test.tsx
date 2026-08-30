// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { leaf, type LayoutLeaf } from "@/lib/layout";
import { registerPanel, unregisterPanel } from "@/lib/panelRegistry";
import { layoutStore } from "@/store/layout";
import PanelDnd from "./PanelDnd";
import PanelLeaf from "./PanelLeaf";

/**
 * Render-level coverage for the thing this task actually shipped: what the
 * user sees while dragging. `panelDnd.test.ts` and `PanelDnd.test.tsx` only
 * exercise `createPanelDragController` in isolation — nothing in the suite
 * previously mounted `PanelDnd` itself, so the caret-only-over-the-bar rule
 * (`PanelDragState.caret`, read verbatim by `PanelDnd.tsx`) was guarded by
 * code reading alone. This file drives a real drag against a real rendered
 * leaf and asserts on the DOM the drag layer produces.
 */

const FIRST_ID = "panel-dnd-render-first";
const SECOND_ID = "panel-dnd-render-second";
let dispose: (() => void) | undefined;

const originalCapture = {
  set: Element.prototype.setPointerCapture,
  release: Element.prototype.releasePointerCapture,
};

beforeAll(() => {
  // jsdom does not implement Pointer Capture; without a stub `begin()`'s
  // `setPointerCapture` call throws "not implemented" and aborts the drag
  // before any state is ever set.
  Element.prototype.setPointerCapture = function () {};
  Element.prototype.releasePointerCapture = function () {};
});

afterAll(() => {
  Element.prototype.setPointerCapture = originalCapture.set;
  Element.prototype.releasePointerCapture = originalCapture.release;
});

beforeEach(() => {
  registerPanel({
    id: FIRST_ID,
    title: "First",
    icon: "file-text",
    kind: "tab",
    component: () => <div>First panel body</div>,
    requiresWorkspace: true,
  });
  registerPanel({
    id: SECOND_ID,
    title: "Second",
    icon: "file-text",
    kind: "tab",
    component: () => <div>Second panel body</div>,
    requiresWorkspace: true,
  });
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  unregisterPanel(FIRST_ID);
  unregisterPanel(SECOND_ID);
  layoutStore.resetToCode();
  layoutStore.setEditing(false);
});

/**
 * A two-tab leaf pinned to a known box: `rect` 400x400 at the origin, a 30px
 * tab bar, and two 100px-wide tabs — everything `measureRenderedLeaves()`
 * (and so `resolveDrop`/`dropCaretRect`) reads. jsdom lays nothing out, so
 * every measured element's `getBoundingClientRect` is overridden directly,
 * the same technique `LayoutNodeView.test.tsx` and `panelDnd.test.ts` use.
 *
 * Dragging only exists in edit mode (Task 9): the tab bar itself is now the
 * drag surface, not each tab button, so this puts the store in edit mode
 * before mounting (unless told not to — see the negative-path test below)
 * and returns the bar rather than a specific tab.
 *
 * The leaf handed to `<PanelLeaf>` here is a plain object, deliberately not
 * wired to `layoutStore` — a real drop (the edge/split case below) restructures
 * the store's tree into something that is no longer a bare `LayoutLeaf` at its
 * root, which a live binding cannot render as one. `mountActivatable` below is
 * the store-backed variant, used only where a click's effect must be observed.
 */
function mount({ editing = true }: { editing?: boolean } = {}) {
  layoutStore.setEditing(editing);
  const node: LayoutLeaf = leaf([FIRST_ID, SECOND_ID], { id: "panel-dnd-render-leaf" });
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => (
      <PanelDnd>
        <PanelLeaf leaf={node} workspace="demo" />
      </PanelDnd>
    ),
    host,
  );

  const leafEl = host.querySelector<HTMLElement>("[data-leaf-id]")!;
  const bar = leafEl.querySelector<HTMLElement>("[data-tab-bar]")!;
  const tabs = [...bar.querySelectorAll<HTMLElement>("[data-tab-index]")];
  leafEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;
  bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 30 }) as DOMRect;
  tabs[0]!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 30 }) as DOMRect;
  tabs[1]!.getBoundingClientRect = () => ({ left: 100, top: 0, width: 100, height: 30 }) as DOMRect;

  return bar;
}

/**
 * Store-backed variant of `mount()`: the leaf is routed through
 * `layoutStore.applyLayout` and re-read via a `live()` accessor (the same
 * technique `PanelLeaf.test.tsx` uses), so `activatePanel` — which acts on
 * the store's tree — actually shows up in what's rendered. Only used by the
 * negative-path test below, which never drives a real drop, so the store's
 * root stays a plain leaf throughout.
 */
function mountActivatable({ editing }: { editing: boolean }) {
  const node: LayoutLeaf = leaf([FIRST_ID, SECOND_ID], { id: "panel-dnd-render-leaf" });
  layoutStore.applyLayout({
    id: "panel-dnd-render-test",
    name: "Panel dnd render test",
    builtin: false,
    layout: { version: 2, root: node },
    hidden: [],
  });
  layoutStore.setEditing(editing);
  const host = document.createElement("div");
  document.body.append(host);
  const live = () => layoutStore.layout().root as LayoutLeaf;
  dispose = render(
    () => (
      <PanelDnd>
        <PanelLeaf leaf={live()} workspace="demo" />
      </PanelDnd>
    ),
    host,
  );

  const leafEl = host.querySelector<HTMLElement>("[data-leaf-id]")!;
  const bar = leafEl.querySelector<HTMLElement>("[data-tab-bar]")!;
  const tabs = [...bar.querySelectorAll<HTMLElement>("[data-tab-index]")];
  leafEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;
  bar.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 30 }) as DOMRect;
  tabs[0]!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 30 }) as DOMRect;
  tabs[1]!.getBoundingClientRect = () => ({ left: 100, top: 0, width: 100, height: 30 }) as DOMRect;

  return bar;
}

function pointerEvent(type: string, x: number, y: number) {
  return new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
}

/** `scheduleMeasure` defers through the real `requestAnimationFrame`. */
function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function preview() {
  return document.querySelector(".panel-drop-preview");
}
function caret() {
  return document.querySelector(".panel-drop-caret");
}
function ghost() {
  return document.querySelector(".panel-drag-ghost");
}

describe("PanelDnd rendered feedback", () => {
  it("shows the filled preview AND the caret for a tab-bar drop", async () => {
    const bar = mount();
    bar.dispatchEvent(pointerEvent("pointerdown", 10, 10));
    // Past the 4px threshold; y=10 is inside the 30px tab bar.
    window.dispatchEvent(pointerEvent("pointermove", 250, 10));
    await nextFrame();

    expect(ghost()).toBeTruthy();
    expect(preview()).toBeTruthy();
    expect(caret()).toBeTruthy();

    window.dispatchEvent(pointerEvent("pointerup", 250, 10));
    expect(preview()).toBeNull();
    expect(caret()).toBeNull();
    expect(ghost()).toBeNull();
  });

  it("shows only the preview for an edge/split drop, never the caret", async () => {
    const bar = mount();
    bar.dispatchEvent(pointerEvent("pointerdown", 10, 10));
    // Past the 4px threshold; (20, 200) is the leftmost 25% of the content
    // area below the bar — resolveDrop's split zone, not its tab zone.
    window.dispatchEvent(pointerEvent("pointermove", 20, 200));
    await nextFrame();

    expect(preview()).toBeTruthy();
    expect(caret()).toBeNull();

    window.dispatchEvent(pointerEvent("pointerup", 20, 200));
    expect(preview()).toBeNull();
  });

  it("shows neither when no drop resolves, and nothing lingers after the drag ends", async () => {
    const bar = mount();
    bar.dispatchEvent(pointerEvent("pointerdown", 10, 10));
    // Past the 4px threshold; far outside the only leaf on screen.
    window.dispatchEvent(pointerEvent("pointermove", 9000, 9000));
    await nextFrame();

    expect(preview()).toBeNull();
    expect(caret()).toBeNull();

    window.dispatchEvent(pointerEvent("pointerup", 9000, 9000));
    expect(preview()).toBeNull();
    expect(caret()).toBeNull();
    expect(ghost()).toBeNull();
  });

  it("never starts a drag outside edit mode, but a plain tab click still activates it", async () => {
    const bar = mountActivatable({ editing: false });
    const tabs = [...bar.querySelectorAll<HTMLElement>("[data-tab-index]")];
    const secondTab = tabs[1]!.querySelector<HTMLButtonElement>("button")!;

    // Same gesture that starts a drag in every test above — well past the 4px
    // threshold — but with no `onPointerDown` attached at all outside edit
    // mode, there is nothing to catch it.
    bar.dispatchEvent(pointerEvent("pointerdown", 10, 10));
    window.dispatchEvent(pointerEvent("pointermove", 250, 10));
    await nextFrame();

    expect(ghost()).toBeNull();
    expect(preview()).toBeNull();
    expect(caret()).toBeNull();

    window.dispatchEvent(pointerEvent("pointerup", 250, 10));
    expect(document.body.classList.contains("panel-dragging")).toBe(false);

    // The gating must not have swallowed ordinary interaction: a real click
    // still switches tabs.
    expect(secondTab.getAttribute("aria-selected")).toBe("false");
    secondTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(secondTab.getAttribute("aria-selected")).toBe("true");
  });

  it("in edit mode, a click below the drag threshold still reaches its target (pointer-capture regression)", async () => {
    // Task 10's live-Electron repro: capturing the pointer on pointerdown
    // (before the 4px threshold is known to have been crossed) makes
    // Chromium retarget the click it synthesizes on pointerup to the
    // capturing element, so a plain click on a tab, "Hide", or "Collapse"
    // inside edit mode did nothing at all. jsdom does not implement that
    // capture-retargeting behaviour — `panelDnd.test.ts`'s "does not take
    // pointer capture until the drag threshold is crossed" is the test that
    // actually exercises the fix — so this instead proves the fix didn't
    // regress the ordinary, un-retargeted path: a real mousedown-then-click
    // sequence (never crossing the threshold) on each edit-mode control
    // reaches that control.
    const bar = mountActivatable({ editing: true });
    const tabs = [...bar.querySelectorAll<HTMLElement>("[data-tab-index]")];
    const secondTab = tabs[1]!.querySelector<HTMLButtonElement>("button")!;
    const hideFirst = tabs[0]!.querySelector<HTMLButtonElement>(".workbench-tab-close")!;
    const collapseBtn = bar.querySelector<HTMLButtonElement>(".workbench-leaf-collapse-btn")!;

    function clickWithoutDragging(el: HTMLElement) {
      el.dispatchEvent(pointerEvent("pointerdown", 10, 10));
      el.dispatchEvent(pointerEvent("pointerup", 11, 10)); // 1px of jitter, well under THRESHOLD
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    expect(secondTab.getAttribute("aria-selected")).toBe("false");
    clickWithoutDragging(secondTab);
    await Promise.resolve();
    expect(secondTab.getAttribute("aria-selected")).toBe("true");

    clickWithoutDragging(hideFirst);
    await Promise.resolve();
    expect(layoutStore.hiddenPanels()).toContain(FIRST_ID);

    // Collapse is spied rather than asserted via the resulting DOM class:
    // `setCollapsed` itself refuses to collapse the sole remaining open leaf
    // (a separate, already-covered rule in `store/layout.test.ts`), and this
    // single-leaf tree has nowhere else for content to go. What this test
    // needs to prove is narrower — that the click reaches the button's
    // handler at all — so it asserts the call, not the store's business
    // logic on top of it.
    const setCollapsed = vi.spyOn(layoutStore, "setCollapsed");
    clickWithoutDragging(collapseBtn);
    expect(setCollapsed).toHaveBeenCalledWith("panel-dnd-render-leaf", true);
    setCollapsed.mockRestore();
  });
});
