// @vitest-environment node
import { describe, expect, it } from "vitest";
import { previewKind } from "./filePreview";

describe("previewKind", () => {
  it("previews markdown", () => {
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("docs/api.markdown")).toBe("markdown");
    expect(previewKind("site/page.mdx")).toBe("markdown");
  });

  it("ignores extension case", () => {
    expect(previewKind("README.MD")).toBe("markdown");
  });

  it("has nothing to preview for source files", () => {
    expect(previewKind("src/lib/diff.ts")).toBeNull();
    expect(previewKind("main.rs")).toBeNull();
  });

  it("has nothing to preview for an extensionless file", () => {
    expect(previewKind("Makefile")).toBeNull();
    expect(previewKind("")).toBeNull();
  });

  it("does not match a directory that looks like an extension", () => {
    expect(previewKind("docs.md/notes.ts")).toBeNull();
  });
});
