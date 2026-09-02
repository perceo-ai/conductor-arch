// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";

import KeyboardHints from "./KeyboardHints";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

describe("KeyboardHints", () => {
  it("shows shortcuts for visible enabled buttons only while Alt is held", () => {
    const host = document.createElement("div");
    document.body.append(host);
    host.innerHTML = `
      <button id="palette" data-shortcut="⌘/Ctrl K">Commands</button>
      <button data-shortcut="⌘/Ctrl B" disabled>Unavailable</button>
      <button data-shortcut="⌘/Ctrl S" aria-disabled="true">Read only</button>
      <button id="offscreen" data-shortcut="⌘/Ctrl O">Offscreen</button>
      <button data-shortcut="⌘/Ctrl P" style="display: none">Hidden</button>
    `;
    const palette = host.querySelector<HTMLButtonElement>("#palette")!;
    palette.getBoundingClientRect = () => ({
      left: 20, right: 100, top: 30, bottom: 60, width: 80, height: 30,
      x: 20, y: 30, toJSON: () => ({}),
    });
    host.querySelector<HTMLElement>("#offscreen")!.getBoundingClientRect = () => ({
      left: 20, right: 100, top: 900, bottom: 930, width: 80, height: 30,
      x: 20, y: 900, toJSON: () => ({}),
    });
    palette.focus();
    dispose = render(() => <KeyboardHints />, host);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", bubbles: true }));

    const hints = document.querySelectorAll(".keyboard-hint");
    expect(hints).toHaveLength(1);
    expect(hints[0]?.textContent).toBe("⌘/Ctrl K");
    expect(document.activeElement).toBe(palette);

    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));
    expect(document.querySelector(".keyboard-hint-layer")).toBeNull();
    expect(document.activeElement).toBe(palette);
  });

  it("dismisses the shortcut layer when the window loses focus", () => {
    const host = document.createElement("div");
    document.body.append(host);
    host.innerHTML = `<button data-shortcut="⌘/Ctrl K">Commands</button>`;
    dispose = render(() => <KeyboardHints />, host);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt" }));
    expect(document.querySelector(".keyboard-hint-layer")).not.toBeNull();

    window.dispatchEvent(new Event("blur"));
    expect(document.querySelector(".keyboard-hint-layer")).toBeNull();
  });
});
