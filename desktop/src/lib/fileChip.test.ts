import { describe, expect, it } from "vitest";
import {
  CHIP_ATTR,
  chatAttachmentPath,
  fileChipAttributes,
  fileChipElement,
  fileChipSpecFor,
  fileChipHtml,
  isChatAttachmentFilename,
  openableChipPath,
  resolveChipPath,
} from "./fileChip";

describe("file chip adapters", () => {
  // The whole point of the module: the composer and the transcript cannot
  // disagree about what a chip is, because they read the same attributes.
  it("gives the string and element adapters the same attributes and text", () => {
    const spec = { path: "src/lib/fileChip.ts", label: "fileChip.ts" };
    const el = fileChipElement(spec);

    for (const [key, value] of Object.entries(fileChipAttributes(spec))) {
      expect(el.getAttribute(key)).toBe(value);
    }
    expect(el.textContent).toBe("fileChip.ts");

    const html = fileChipHtml(spec);
    for (const [key, value] of Object.entries(fileChipAttributes(spec))) {
      expect(html).toContain(`${key}="${value}"`);
    }
  });

  it("carries the file's type icon on both surfaces", () => {
    const spec = { path: "src/main.rs", label: "main.rs" };
    expect(fileChipElement(spec).querySelector("img.chat-chip-icon")).not.toBeNull();
    expect(fileChipHtml(spec)).toContain('class="chat-chip-icon"');
  });

  it("keeps the icon out of the chip's text, so caret arithmetic still measures the label", () => {
    // `nodesFromDom` and `caretOffset` measure textContent; an <img> that
    // contributed text would shift every mention offset to its right.
    expect(fileChipElement({ path: "a/b.md", label: "b.md" }).textContent).toBe("b.md");
  });

  it("escapes hostile labels, since the transcript chip reaches innerHTML", () => {
    const html = fileChipHtml({
      path: '"><script>alert(1)</script>',
      label: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("marks chips so the click handler and CSS can find them", () => {
    expect(fileChipElement({ path: "a.md", label: "a.md" }).getAttribute(CHIP_ATTR)).toBe("file");
  });

  it("marks a resolved chip openable and an unresolved one not", () => {
    const open = fileChipElement({ path: "docs/a.md", label: "a.md", openable: true });
    expect(open.getAttribute("data-openable")).toBe("true");

    const inert = fileChipElement({ path: "a.md", label: "a.md", openable: false });
    expect(inert.getAttribute("data-openable")).toBeNull();
    // The tooltip has to say why nothing happens on click.
    expect(inert.getAttribute("title")).toContain("not found");
  });
});

describe("fileChipSpecFor", () => {
  it("marks a chip openable when the filename resolves", () => {
    const spec = fileChipSpecFor("guide.md", { threadId: 1, files: ["docs/guide.md"] });
    expect(spec).toEqual({ path: "docs/guide.md", label: "guide.md", openable: true });
  });

  it("falls back to an inert chip carrying the label as its path", () => {
    const spec = fileChipSpecFor("ghost.ts", { threadId: 1, files: [] });
    expect(spec).toEqual({ path: "ghost.ts", label: "ghost.ts", openable: false });
  });
});

describe("openableChipPath", () => {
  it("returns the path when the click lands on a resolved chip", () => {
    const chip = fileChipElement({ path: "docs/guide.md", label: "guide.md", openable: true });
    expect(openableChipPath(chip)).toBe("docs/guide.md");
  });

  it("finds the chip when the click lands on its icon", () => {
    // The icon fills most of a chip's left edge, so this is the common case.
    const chip = fileChipElement({ path: "docs/guide.md", label: "guide.md", openable: true });
    expect(openableChipPath(chip.querySelector("img"))).toBe("docs/guide.md");
  });

  it("ignores an unresolved chip", () => {
    const chip = fileChipElement({ path: "ghost.ts", label: "ghost.ts", openable: false });
    expect(openableChipPath(chip)).toBeNull();
  });

  it("ignores a click that missed every chip", () => {
    expect(openableChipPath(document.createElement("p"))).toBeNull();
    expect(openableChipPath(null)).toBeNull();
  });
});

describe("isChatAttachmentFilename", () => {
  it("recognises what save_chat_attachment writes", () => {
    expect(isChatAttachmentFilename("pasted-text-a1b2c3d4.md")).toBe(true);
    expect(isChatAttachmentFilename("create-pr-prompt-0f9e8d7c.md")).toBe(true);
    expect(isChatAttachmentFilename("screenshot-00112233.png")).toBe(true);
  });

  it("does not mistake an ordinary source file for one", () => {
    expect(isChatAttachmentFilename("fileChip.ts")).toBe(false);
    expect(isChatAttachmentFilename("README.md")).toBe(false);
    // Right shape, wrong suffix length.
    expect(isChatAttachmentFilename("notes-a1b2c3.md")).toBe(false);
  });
});

describe("resolveChipPath", () => {
  it("computes an attachment path rather than searching for it", () => {
    // `.context/` is normally gitignored, so the file list will not contain it.
    expect(resolveChipPath("pasted-text-a1b2c3d4.md", { threadId: 42, files: [] })).toBe(
      chatAttachmentPath(42, "pasted-text-a1b2c3d4.md"),
    );
  });

  it("falls back to a unique match in the workspace file list", () => {
    const files = ["src/lib/fileChip.ts", "docs/guide.md"];
    expect(resolveChipPath("guide.md", { threadId: 1, files })).toBe("docs/guide.md");
  });

  it("stays inert when the filename is ambiguous", () => {
    // Two candidates and no way to tell which was meant: opening the wrong file
    // is worse than the chip doing nothing.
    const files = ["a/mod.rs", "b/mod.rs"];
    expect(resolveChipPath("mod.rs", { threadId: 1, files })).toBeNull();
  });

  it("stays inert when nothing matches", () => {
    expect(resolveChipPath("ghost.ts", { threadId: 1, files: ["src/real.ts"] })).toBeNull();
  });

  it("does not build an attachment path without a thread", () => {
    expect(resolveChipPath("pasted-text-a1b2c3d4.md", { threadId: null, files: [] })).toBeNull();
  });
});
