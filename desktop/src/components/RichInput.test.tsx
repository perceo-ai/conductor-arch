// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import RichInput, { type RichInputApi } from "./RichInput";
import { CHIP_ATTR, toVisible, type ComposerNode } from "@/lib/composerDocument";

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

function mount(props: Partial<Parameters<typeof RichInput>[0]> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const onInput = vi.fn();
  let api: RichInputApi | undefined;
  dispose = render(
    () => (
      <RichInput
        nodes={props.nodes ?? (() => [])}
        onInput={props.onInput ?? onInput}
        onKeyDown={props.onKeyDown}
        onPaste={props.onPaste}
        placeholder={props.placeholder ?? "Ask to make changes"}
        ref={(a) => (api = a)}
      />
    ),
    host,
  );
  const el = host.querySelector("[contenteditable]") as HTMLElement;
  return { el, api: api!, onInput };
}

/** Put a collapsed caret at the end of the input, as focusing it would. */
function caretToEnd(el: HTMLElement) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function shiftEnter(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
}

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

describe("RichInput", () => {
  it("renders a file node as a chip the caret cannot enter", () => {
    const { el } = mount({ nodes: () => [{ kind: "file", path: "src/a.ts", label: "a.ts" }] });
    const chip = el.querySelector(`[${CHIP_ATTR}="file"]`) as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.getAttribute("contenteditable")).toBe("false");
    expect(chip.textContent).toBe("a.ts");
    expect(chip.title).toBe("src/a.ts");
  });

  it("puts the file's type icon on the left of its chip", () => {
    const { el } = mount({ nodes: () => [{ kind: "file", path: "src/a.ts", label: "a.ts" }] });
    const chip = el.querySelector(`[${CHIP_ATTR}="file"]`) as HTMLElement;
    const icon = chip.firstElementChild as HTMLImageElement;
    expect(icon?.tagName).toBe("IMG");
    expect(icon.getAttribute("src")).toBeTruthy();
    // Decorative: the label beside it already names the file.
    expect(icon.getAttribute("alt")).toBe("");
    // The icon must not become part of the chip's text, which is what
    // `nodesFromDom` and the caret arithmetic read.
    expect(chip.textContent).toBe("a.ts");
  });

  it("picks the icon from the file's own extension", () => {
    const { el } = mount({
      nodes: () => [
        { kind: "file", path: "a.ts", label: "a.ts" },
        { kind: "file", path: "b.rs", label: "b.rs" },
      ],
    });
    const [ts, rs] = [...el.querySelectorAll(`[${CHIP_ATTR}="file"] img`)] as HTMLImageElement[];
    expect(ts.getAttribute("src")).not.toBe(rs.getAttribute("src"));
  });

  it("renders a command node as a chip", () => {
    const { el } = mount({ nodes: () => [{ kind: "command", name: "review" }] });
    expect(el.querySelector(`[${CHIP_ATTR}="command"]`)?.textContent).toBe("/review");
  });

  it("carries the placeholder for the empty-state CSS to show", () => {
    const { el } = mount();
    expect(el.getAttribute("data-placeholder")).toBe("Ask to make changes");
    expect(el.childNodes).toHaveLength(0);
  });

  it("paints a newline as a <br> so the caret has a line to land on", () => {
    const { el } = mount({ nodes: () => [{ kind: "text", text: "a\nb" }] });
    expect(el.querySelectorAll("br")).toHaveLength(1);
  });

  it("reports the document back after the browser edits it", () => {
    const onInput = vi.fn();
    const { el } = mount({ nodes: () => [{ kind: "text", text: "hi" }], onInput });
    el.append(" there");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onInput).toHaveBeenCalled();
    expect(toVisible(onInput.mock.lastCall![0] as ComposerNode[])).toBe("hi there");
  });

  it("replaces the whole document when asked", () => {
    const { el, api } = mount({ nodes: () => [{ kind: "text", text: "a" }] });
    api.setNodes([
      { kind: "text", text: "b " },
      { kind: "file", path: "src/c.ts", label: "c.ts" },
    ]);
    expect(el.querySelectorAll(`[${CHIP_ATTR}]`)).toHaveLength(1);
    expect(el.textContent).toBe("b c.ts");
  });

  it("inserts pasted content as text, never as markup", () => {
    const { el } = mount();
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "<b>x</b>" } });
    el.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(el.querySelector("b")).toBeNull();
    expect(el.textContent).toBe("<b>x</b>");
  });

  it("inserts a line break for Shift+Enter", () => {
    const { el } = mount({ nodes: () => [{ kind: "text", text: "hi" }] });
    caretToEnd(el);
    el.dispatchEvent(shiftEnter());
    expect(el.querySelectorAll("br")).toHaveLength(1);
  });

  it("lets the composer's own key handling win over the newline default", () => {
    // The composer preventDefaults Enter to send; RichInput must not then also
    // insert a line break into a message that is already on its way out.
    const onKeyDown = vi.fn((e: KeyboardEvent) => e.preventDefault());
    const { el } = mount({ nodes: () => [{ kind: "text", text: "hi" }], onKeyDown });
    caretToEnd(el);
    el.dispatchEvent(shiftEnter());
    expect(onKeyDown).toHaveBeenCalled();
    expect(el.querySelectorAll("br")).toHaveLength(0);
  });
});
