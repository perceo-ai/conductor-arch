export type PastedAttachment = {
  label: string;
  kind: "file" | "image";
  dataBase64: string;
};

const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export async function pastedAttachmentsFromClipboard(data: DataTransfer | null | undefined): Promise<PastedAttachment[]> {
  const files = clipboardFiles(data);
  const attachments: PastedAttachment[] = [];
  for (const file of files) attachments.push(await fileToPastedAttachment(file));
  return attachments;
}

function clipboardFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

async function fileToPastedAttachment(file: File): Promise<PastedAttachment> {
  const kind = file.type.startsWith("image/") ? "image" : "file";
  const label = file.name || fallbackName(file.type, kind);
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error(`${label} is larger than 25 MiB`);
  }
  return {
    label,
    kind,
    dataBase64: arrayBufferToBase64(await file.arrayBuffer()),
  };
}

function fallbackName(mime: string, kind: "file" | "image"): string {
  if (kind === "image") return `pasted-image.${imageExtension(mime)}`;
  return "pasted-file.bin";
}

function imageExtension(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}
