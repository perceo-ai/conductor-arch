// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { pastedAttachmentsFromClipboard } from "./pasteAttachments";

function clipboardWith(files: File[]): DataTransfer {
  return {
    files,
    items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
  } as unknown as DataTransfer;
}

describe("pastedAttachmentsFromClipboard", () => {
  it("turns pasted image files into base64 image attachments", async () => {
    const { attachments } = await pastedAttachmentsFromClipboard(
      clipboardWith([new File([new Uint8Array([0x89, 0x50])], "mockup.png", { type: "image/png" })]),
    );

    expect(attachments[0]).toEqual({
      label: "mockup.png",
      kind: "image",
      dataBase64: "iVA=",
    });
  });

  it("keeps non-image pasted files as file attachments", async () => {
    const { attachments } = await pastedAttachmentsFromClipboard(
      clipboardWith([new File(["hello"], "notes.txt", { type: "text/plain" })]),
    );

    expect(attachments[0]).toEqual({
      label: "notes.txt",
      kind: "file",
      dataBase64: "aGVsbG8=",
    });
  });

  it("reports files too large for the chat attachment transport without dropping the rest", async () => {
    const huge = {
      name: "huge.zip",
      type: "application/zip",
      size: 25 * 1024 * 1024 + 1,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as File;

    const { attachments, failed } = await pastedAttachmentsFromClipboard(
      clipboardWith([huge, new File(["hello"], "notes.txt", { type: "text/plain" })]),
    );

    expect(failed).toEqual(["huge.zip"]);
    expect(attachments.map((a) => a.label)).toEqual(["notes.txt"]);
  });
});
