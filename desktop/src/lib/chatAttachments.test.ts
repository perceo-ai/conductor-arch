import { describe, expect, it } from "vitest";
import { fileNameFromPath, inlineFileMentionAt } from "./chatAttachments";

describe("chat attachments", () => {
  it("names a file by its last path segment", () => {
    expect(fileNameFromPath("docs/spec.md")).toBe("spec.md");
    expect(fileNameFromPath(".context/archductor/42/pasted-text-a1b2c3d4.md")).toBe(
      "pasted-text-a1b2c3d4.md",
    );
  });

  it("finds the active @ file mention before the cursor", () => {
    expect(inlineFileMentionAt("read @src/lib", 13)).toEqual({
      start: 5,
      end: 13,
      query: "src/lib",
    });
    expect(inlineFileMentionAt("email a@b", 9)).toBeNull();
  });
});
