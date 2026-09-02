// Mirrors the rest of the suite's render pattern (see PanelLeaf.test.tsx):
// `@solidjs/testing-library` is not a dependency of this project, so this
// mounts with `solid-js/web` directly and reads the DOM rather than using
// Testing Library queries.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import LayoutEditBar from "./LayoutEditBar";
import { layoutStore } from "@/store/layout";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  layoutStore.setEditing(false);
});

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <LayoutEditBar />, host);
  return host;
}

describe("layout edit bar", () => {
  it("renders nothing outside edit mode", () => {
    layoutStore.setEditing(false);
    const host = mount();
    expect(host.textContent).toBe("");
  });

  it("offers Done, reset, and the hidden panels in edit mode", () => {
    layoutStore.setEditing(true);
    const host = mount();
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Done"))).toBe(true);
    expect(host.textContent).toContain("Editing layout");
  });

  it("adds a panel by mouse: a pointerdown on a menu item does not dismiss the menu before its click lands", () => {
    // The bug: a `{ once: true }` window "pointerdown" listener dismissed the
    // menu on ANY pointerdown, including the opening pointerdown of the very
    // click meant to select an item — the menu unmounted before the matching
    // click ever reached the item's handler, so `addPanel` never ran. jsdom
    // does not retarget events the way Chromium's pointer capture does (see
    // `PanelDndController.ts`'s fix and tests for that separate mechanism),
    // but it *does* faithfully deliver a plain "pointerdown" listener on
    // window — exactly the mechanism this bug lived in — so this reproduces
    // it directly, not just the "next best thing".
    layoutStore.setEditing(true);
    const host = mount();

    const addTrigger = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Add panel"),
    )!;
    addTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const menuBefore = host.querySelector(".layout-edit-add-menu");
    expect(menuBefore).toBeTruthy();

    const terminalItem = [...host.querySelectorAll<HTMLButtonElement>(".layout-edit-add-item")].find((item) =>
      item.textContent?.includes("Terminal"),
    )!;
    expect(terminalItem).toBeTruthy();
    expect(layoutStore.hiddenPanels()).toContain("terminal");

    terminalItem.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    // The crux of the regression: the menu must still be mounted right after
    // the pointerdown that starts the click, or the click that follows has
    // nothing left to land on.
    expect(host.querySelector(".layout-edit-add-menu")).toBeTruthy();

    terminalItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(layoutStore.hiddenPanels()).not.toContain("terminal");
    // Selecting an item does still close the menu — just after, not before,
    // its own click.
    expect(host.querySelector(".layout-edit-add-menu")).toBeNull();
  });

  it("dismisses the add-panel menu on an outside pointerdown", () => {
    layoutStore.setEditing(true);
    const host = mount();

    const addTrigger = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Add panel"),
    )!;
    addTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(host.querySelector(".layout-edit-add-menu")).toBeTruthy();

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(host.querySelector(".layout-edit-add-menu")).toBeNull();
  });
});
