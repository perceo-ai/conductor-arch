import { describe, expect, it } from "vitest";
import {
  attachmentMarker,
  fileNameFromPath,
  insertInlineAttachmentMarker,
  promptTextWithAttachmentRefs,
  type ComposerAttachment,
} from "./chatAttachments";

describe("chat attachment markers", () => {
  it("uses the saved file name as the visible inline marker", () => {
    expect(attachmentMarker(".context/archductor/42/pasted-text-a1b2c3d4.md")).toBe(
      "{pasted-text-a1b2c3d4.md}",
    );
    expect(fileNameFromPath("docs/spec.md")).toBe("spec.md");
  });

  it("inserts a marker inline at the current cursor", () => {
    expect(insertInlineAttachmentMarker("abc abc", "{pasted.md}", 3, 3)).toEqual({
      value: "abc {pasted.md} abc",
      cursor: 15,
    });
  });

  it("sends inline markers as agent-readable path references", () => {
    const attachments: ComposerAttachment[] = [
      {
        path: ".context/archductor/42/pasted-text-a1b2c3d4.md",
        label: "pasted text",
        marker: "{pasted-text-a1b2c3d4.md}",
      },
    ];
    expect(promptTextWithAttachmentRefs("read {pasted-text-a1b2c3d4.md} now", attachments)).toBe(
      "read @.context/archductor/42/pasted-text-a1b2c3d4.md now",
    );
  });
});
