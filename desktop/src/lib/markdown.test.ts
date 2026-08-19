import { describe, expect, it } from "vitest";
import { renderMarkdownWithInlineFileChips } from "./markdown";

describe("renderMarkdownWithInlineFileChips", () => {
  it("renders file markers as compact inline chips", () => {
    expect(renderMarkdownWithInlineFileChips("abc {pasted-text-a1b2c3d4.md} abc")).toContain(
      '<span class="chat-inline-file-chip" title="pasted-text-a1b2c3d4.md">pasted-text-a1b2c3d4.md</span>',
    );
  });
});
