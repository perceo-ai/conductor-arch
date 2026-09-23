import { describe, expect, it } from "vitest";
import {
  renderMarkdown,
  renderMarkdownDocument,
  renderMarkdownWithInlineFileChips,
} from "./markdown";
import { fileChipHtml } from "./fileChip";

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
  it("renders file markers as chips", () => {
    const html = renderMarkdownWithInlineFileChips("abc {pasted-text-a1b2c3d4.md} abc");
    expect(html).toContain('data-chip="file"');
    expect(html).toContain('data-label="pasted-text-a1b2c3d4.md"');
  });

  it("draws the same chip the composer draws", () => {
    // These two used to build their own markup and had drifted: the composer's
    // chip had the file's type icon and the accent treatment, this one was a
    // plain grey span. The same attachment must not look like two things.
    const spec = { path: "docs/guide.md", label: "guide.md", openable: true };
    const html = renderMarkdownWithInlineFileChips("see {guide.md}", {
      threadId: 1,
      files: ["docs/guide.md"],
    });
    expect(html).toContain(fileChipHtml(spec));
  });

  it("points a resolved chip at the file it stands for", () => {
    const html = renderMarkdownWithInlineFileChips("see {guide.md}", {
      threadId: 1,
      files: ["docs/guide.md"],
    });
    expect(html).toContain('data-path="docs/guide.md"');
    expect(html).toContain('data-openable="true"');
  });

  it("resolves a chat attachment against the thread's attachment directory", () => {
    // `.context/` is gitignored, so this never comes back in the file list.
    const html = renderMarkdownWithInlineFileChips("{pasted-text-a1b2c3d4.md}", {
      threadId: 42,
      files: [],
    });
    expect(html).toContain('data-path=".context/archductor/42/pasted-text-a1b2c3d4.md"');
  });

  it("leaves an unresolvable chip inert rather than pointing it at a bare filename", () => {
    const html = renderMarkdownWithInlineFileChips("see {ghost.ts}", { threadId: 1, files: [] });
    expect(html).toContain('data-chip="file"');
    expect(html).not.toContain("data-openable");
  });

  it("still renders chips when given no resolution context at all", () => {
    expect(renderMarkdownWithInlineFileChips("see {guide.md}")).toContain('data-chip="file"');
  });
});

describe("markdown images", () => {
  it("renders a markdown image as a labeled chip, not an <img>", () => {
    const html = renderMarkdown("![dashboard screenshot](/tmp/shots/01-dashboard.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("md-image-chip");
    expect(html).toContain("dashboard screenshot");
    expect(html).toContain("/tmp/shots/01-dashboard.png");
  });

  it("falls back to the filename when the image has no alt text", () => {
    const html = renderMarkdown("![](/tmp/shots/02-workspace.png)");
    expect(html).toContain("02-workspace.png");
  });

  it("escapes hostile alt text and titles in image chips", () => {
    const html = renderMarkdown('![<script>x</script>](/a.png "t<i>t")');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("t<i>t");
  });
});
