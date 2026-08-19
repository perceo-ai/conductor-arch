import { describe, expect, it } from "vitest";
import {
  renderMarkdown,
  renderMarkdownDocument,
  renderMarkdownWithInlineFileChips,
} from "./markdown";

describe("renderMarkdownDocument", () => {
  it("reflows a single newline instead of breaking the line", () => {
    // A chat message treats newlines as intentional; a .md file does not, and
    // breaking mid-sentence is the giveaway that a preview isn't faithful.
    expect(renderMarkdownDocument("one\ntwo")).not.toContain("<br>");
  });

  it("still breaks a paragraph on a blank line", () => {
    const html = renderMarkdownDocument("one\n\ntwo");
    expect(html).toContain("<p>one</p>");
    expect(html).toContain("<p>two</p>");
  });

  it("keeps chat rendering on hard breaks", () => {
    expect(renderMarkdown("one\ntwo")).toContain("<br>");
  });

  it("highlights fenced code the same way chat does", () => {
    expect(renderMarkdownDocument("```ts\nconst a = 1;\n```")).toContain('<pre class="md-code hljs">');
  });

  it("escapes raw HTML, since file contents reach innerHTML", () => {
    // The payload survives as inert text; what must not survive is a live tag.
    const html = renderMarkdownDocument('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("renderMarkdownWithInlineFileChips", () => {
  it("renders file markers as compact inline chips", () => {
    expect(renderMarkdownWithInlineFileChips("abc {pasted-text-a1b2c3d4.md} abc")).toContain(
      '<span class="chat-inline-file-chip" title="pasted-text-a1b2c3d4.md">pasted-text-a1b2c3d4.md</span>',
    );
  });
});
