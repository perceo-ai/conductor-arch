// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CHIP_ATTR, caretOffset, nodesFromDom } from "./composerDocument";

function build(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

const CHIP = `<span ${CHIP_ATTR}="file" data-path="src/a.ts" data-label="a.ts">a.ts</span>`;

describe("nodesFromDom", () => {
  it("reads text and chips in document order", () => {
    expect(nodesFromDom(build(`read ${CHIP} now`))).toEqual([
      { kind: "text", text: "read " },
      { kind: "file", path: "src/a.ts", label: "a.ts" },
      { kind: "text", text: " now" },
    ]);
  });

  it("reads a command chip", () => {
    const root = build(`<span ${CHIP_ATTR}="command" data-name="review">/review</span>`);
    expect(nodesFromDom(root)).toEqual([{ kind: "command", name: "review" }]);
  });

  it("treats a <br> as the newline it renders", () => {
    expect(nodesFromDom(build("a<br>b"))).toEqual([{ kind: "text", text: "a\nb" }]);
  });

  it("keeps the text of a wrapper the browser invented and drops the wrapper", () => {
    // Some engines wrap a pasted line in a <div>; the document is still flat.
    expect(nodesFromDom(build("a<div>b</div>"))).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("reads an empty input as an empty document", () => {
    expect(nodesFromDom(build(""))).toEqual([]);
  });
});

describe("caretOffset", () => {
  it("counts a chip as the width of its visible token", () => {
    const root = build(`read ${CHIP} now`);
    const tail = root.childNodes[2] as Text;
    // "read " (5) + "{a.ts}" (6) + " no" (3)
    expect(caretOffset(root, tail, 3)).toBe(14);
  });

  it("is zero at the start", () => {
    const root = build(`read ${CHIP}`);
    expect(caretOffset(root, root.childNodes[0] as Text, 0)).toBe(0);
  });

  it("counts a whole chip when the caret is the element offset after it", () => {
    const root = build(CHIP);
    expect(caretOffset(root, root, 1)).toBe(6);
  });

  it("counts a <br> as one character", () => {
    const root = build("ab<br>cd");
    expect(caretOffset(root, root.childNodes[2] as Text, 2)).toBe(5);
  });
});
