import { onMount } from "solid-js";
import {
  CHIP_ATTR,
  caretOffset,
  nodeText,
  nodesFromDom,
  type ComposerNode,
} from "@/lib/composerDocument";

export interface RichInputApi {
  focus(): void;
  /** Replace the whole document, optionally putting the caret at a visible offset. */
  setNodes(nodes: ComposerNode[], caret?: number): void;
  caret(): number;
  isEmpty(): boolean;
}

/**
 * The composer's input.
 *
 * A `contenteditable` rather than a `<textarea>` because a textarea can only
 * hold characters, and an `@file` needs a box of its own to read as the thing
 * it is. The previous design faked that with a markdown preview layer stacked
 * under a textarea whose own glyphs were transparent — and two layers cannot be
 * kept in step. They disagreed on font size and padding, so the caret sat in
 * one place and the words in another; and markdown rendering changes the
 * character stream anyway, so no amount of aligning the two would have fixed
 * the general case. Here there is one layer, so the question cannot arise.
 *
 * Chips are `contenteditable="false"`, which is what makes them atomic: the
 * browser steps the caret over them and deletes them whole, behaviour the old
 * composer hand-rolled against the string in `removeAdjacentAttachmentMarker`.
 *
 * The document is painted from `nodes` on mount and on `setNodes`, never on
 * input.
 */
export default function RichInput(props: {
  nodes: () => ComposerNode[];
  onInput: (nodes: ComposerNode[], caret: number) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onPaste?: (e: ClipboardEvent, insert: (text: string) => void) => void;
  placeholder: string;
  class?: string;
  ref?: (api: RichInputApi) => void;
}) {
  let el: HTMLDivElement | undefined;
  // Mid-composition every keystroke is provisional; reporting them opens the
  // file menu on the first letter of a CJK word and closes it on the next.
  let composing = false;

  function chipElement(node: Extract<ComposerNode, { kind: "file" | "command" }>): HTMLSpanElement {
    const chip = document.createElement("span");
    chip.setAttribute(CHIP_ATTR, node.kind);
    chip.setAttribute("contenteditable", "false");
    if (node.kind === "file") {
      chip.setAttribute("data-path", node.path);
      chip.setAttribute("data-label", node.label);
      chip.title = node.path;
      chip.textContent = node.label;
    } else {
      chip.setAttribute("data-name", node.name);
      chip.textContent = nodeText(node);
    }
    return chip;
  }

  function paint(nodes: ComposerNode[]) {
    if (!el) return;
    const children: Node[] = [];
    for (const node of nodes) {
      if (node.kind !== "text") {
        children.push(chipElement(node));
        continue;
      }
      // A newline has to be a real <br>: `white-space: pre-wrap` renders a "\n"
      // but gives the caret no line box to land on at the end of the document.
      const lines = node.text.split("\n");
      lines.forEach((line, i) => {
        if (i > 0) children.push(document.createElement("br"));
        if (line !== "") children.push(document.createTextNode(line));
      });
    }
    el.replaceChildren(...children);
  }

  /** Place the caret at a visible-string offset, stepping over chips. */
  function placeCaret(offset: number) {
    if (!el) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    let remaining = offset;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const length = (child.textContent ?? "").length;
        if (remaining <= length) {
          range.setStart(child, remaining);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        remaining -= length;
        continue;
      }
      const element = child as Element;
      const width = element.tagName === "BR" ? 1 : nodeWidth(element);
      if (remaining < width) break;
      remaining -= width;
    }
    // Past the end (or inside a chip, which has no caret position of its own):
    // the end of the document is the honest place to land.
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** Visible width of a painted chip, without re-deriving the node. */
  function nodeWidth(element: Element): number {
    return element.getAttribute(CHIP_ATTR) === "command"
      ? (element.textContent ?? "").length
      : (element.textContent ?? "").length + 2; // the braces a file marker carries
  }

  function currentCaret(): number {
    if (!el) return 0;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;
    const range = selection.getRangeAt(0);
    if (!el.contains(range.startContainer)) return 0;
    return caretOffset(el, range.startContainer, range.startOffset);
  }

  function report() {
    if (!el || composing) return;
    props.onInput(nodesFromDom(el), currentCaret());
  }

  function insertText(value: string) {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || !el) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const text = document.createTextNode(value);
    range.insertNode(text);
    range.setStartAfter(text);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    report();
  }

  onMount(() => {
    paint(props.nodes());
    props.ref?.({
      focus: () => el?.focus(),
      setNodes: (nodes, caret) => {
        paint(nodes);
        el?.focus();
        if (caret != null) placeCaret(caret);
      },
      caret: currentCaret,
      isEmpty: () => (el?.childNodes.length ?? 0) === 0,
    });
  });

  return (
    <div
      ref={el}
      class={props.class ?? "chat-input-view"}
      contentEditable
      role="textbox"
      aria-multiline="true"
      data-placeholder={props.placeholder}
      onInput={report}
      onCompositionStart={() => {
        composing = true;
      }}
      onCompositionEnd={() => {
        composing = false;
        report();
      }}
      onKeyDown={(e) => {
        props.onKeyDown?.(e);
        if (e.defaultPrevented) return;
        // Shift+Enter is a newline. Left to the browser it produces a wrapping
        // <div> in some engines and a bare <br> in others; inserting the <br>
        // ourselves means `nodesFromDom` sees one shape everywhere.
        if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          const selection = document.getSelection();
          if (!selection || selection.rangeCount === 0) return;
          const range = selection.getRangeAt(0);
          range.deleteContents();
          const br = document.createElement("br");
          range.insertNode(br);
          range.setStartAfter(br);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          report();
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        const pasted = e.clipboardData?.getData("text") ?? "";
        if (props.onPaste) props.onPaste(e, insertText);
        else insertText(pasted);
      }}
    />
  );
}
