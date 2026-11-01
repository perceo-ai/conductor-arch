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
    const [attachment] = await pastedAttachmentsFromClipboard(
      clipboardWith([new File([new Uint8Array([0x89, 0x50])], "mockup.png", { type: "image/png" })]),
    );

    expect(attachment).toEqual({
      label: "mockup.png",
      kind: "image",
      dataBase64: "iVA=",
    });
  });

  it("keeps non-image pasted files as file attachments", async () => {
    const [attachment] = await pastedAttachmentsFromClipboard(
      clipboardWith([new File(["hello"], "notes.txt", { type: "text/plain" })]),
    );

    expect(attachment).toEqual({
      label: "notes.txt",
      kind: "file",
      dataBase64: "aGVsbG8=",
    });
  });

  it("rejects files too large for the chat attachment transport", async () => {
    const file = {
      name: "huge.zip",
      type: "application/zip",
      size: 25 * 1024 * 1024 + 1,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as File;

    await expect(pastedAttachmentsFromClipboard(clipboardWith([file]))).rejects.toThrow(
      "huge.zip is larger than 25 MiB",
    );
  });
});
