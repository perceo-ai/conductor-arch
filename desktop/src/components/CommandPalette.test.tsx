// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";

import CommandPalette from "./CommandPalette";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("CommandPalette keyboard focus", () => {
  it("traps focus while open and restores the exact prior control on close", async () => {
    const background = document.createElement("div");
    background.className = "window-content";
    const opener = document.createElement("button");
    opener.textContent = "Open commands";
    background.append(opener);
    document.body.append(background);
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <CommandPalette />, host);
    opener.focus();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await Promise.resolve();

    const dialog = document.querySelector<HTMLElement>("[role='dialog'][aria-modal='true']");
    const input = dialog?.querySelector<HTMLInputElement>("[role='combobox']");
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(background.hasAttribute("inert")).toBe(true);

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input?.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();

    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(background.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("moves focus to the new page surface when the opener was removed by navigation", async () => {
    const background = document.createElement("div");
    background.className = "window-content";
    const opener = document.createElement("button");
    const destination = document.createElement("main");
    destination.dataset.focusTarget = "workspace-main";
    destination.tabIndex = -1;
    background.append(opener, destination);
    document.body.append(background);
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <CommandPalette />, host);
    opener.focus();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    await Promise.resolve();
    opener.remove();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await Promise.resolve();

    expect(document.activeElement).toBe(destination);
  });
});
