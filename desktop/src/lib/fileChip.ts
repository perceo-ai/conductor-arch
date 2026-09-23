import { escapeHtml } from "./highlight";
import { materialFileIcon } from "./materialFileIcons";

/**
 * One definition of what a file chip *is*, shared by the two surfaces that draw
 * one: the composer (`RichInput`, real DOM) and the transcript (`markdown.ts`,
 * an HTML string).
 *
 * They used to build their own markup independently, and had drifted — the
 * composer's chip carried the file's type icon and the accent colour, the
 * transcript's was a plain grey span. So the same attachment looked like two
 * different things depending on whether you had sent it yet. Both adapters here
 * derive from `fileChipAttributes`, which is what keeps that from happening
 * again; `fileChip.test.ts` asserts the two agree.
 */

/** Marks a chip element. Also the hook the CSS, the click handler, and the tests select on. */
export const CHIP_ATTR = "data-chip";

export interface FileChipSpec {
  /** Workspace-relative path, when known. Falls back to the label. */
  path: string;
  /** The visible text — a bare filename. */
  label: string;
  /**
   * Whether `path` is a real location a click should open. False for a chip
   * whose filename could not be resolved, where `path` is only the label —
   * opening that would ask the daemon for a file that does not exist.
   */
  openable?: boolean;
}

/**
 * The attributes both adapters set, in one place.
 *
 * `data-path` is always present because the composer round-trips it back out of
 * the DOM (`nodesFromDom`); `data-openable` is what the click handler gates on,
 * so an unresolved chip stays inert rather than opening a path that is really
 * just a filename.
 */
export function fileChipAttributes(spec: FileChipSpec): Record<string, string> {
  const attrs: Record<string, string> = {
    [CHIP_ATTR]: "file",
    "data-path": spec.path,
    "data-label": spec.label,
    title: spec.openable === false ? `${spec.label} (not found in this workspace)` : spec.path,
  };
  if (spec.openable !== false) attrs["data-openable"] = "true";
  return attrs;
}

/**
 * Build a chip for a bare filename out of a sent message, resolving where it
 * lives. The single place the "can this be opened?" decision is made, so the
 * composer and the transcript answer it the same way.
 */
export function fileChipSpecFor(
  label: string,
  opts: { threadId?: number | null; files?: readonly string[] },
): FileChipSpec {
  const path = resolveChipPath(label, opts);
  return path ? { path, label, openable: true } : { path: label, label, openable: false };
}

/** Icon URL for a chip, by file type. Separate so both adapters agree on it. */
export function fileChipIconSrc(spec: FileChipSpec): string {
  return materialFileIcon(spec.path).src;
}

/**
 * The transcript's chip: an HTML string bound for `innerHTML`.
 *
 * Everything interpolated here is escaped — the label comes out of agent output
 * via the marker grammar, so it is untrusted in exactly the way the rest of
 * `markdown.ts` treats agent output as untrusted.
 */
export function fileChipHtml(spec: FileChipSpec): string {
  const attrs = Object.entries(fileChipAttributes(spec))
    .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
    .join(" ");
  const icon = `<img class="chat-chip-icon" src="${escapeHtml(fileChipIconSrc(spec))}" alt="">`;
  const label = `<span class="chat-chip-label">${escapeHtml(spec.label)}</span>`;
  return `<span ${attrs}>${icon}${label}</span>`;
}

/**
 * The composer's chip: a real element.
 *
 * An `<img>` contributes no text, which matters here — the chip's `textContent`
 * is what `nodesFromDom` and the caret arithmetic measure.
 */
export function fileChipElement(spec: FileChipSpec): HTMLSpanElement {
  const chip = document.createElement("span");
  for (const [key, value] of Object.entries(fileChipAttributes(spec))) {
    chip.setAttribute(key, value);
  }
  const icon = document.createElement("img");
  icon.className = "chat-chip-icon";
  icon.src = fileChipIconSrc(spec);
  icon.alt = "";
  // The label needs its own box for `text-overflow` to apply: a bare text node
  // inside an inline-flex chip hard-clips instead of showing an ellipsis.
  const label = document.createElement("span");
  label.className = "chat-chip-label";
  label.textContent = spec.label;
  chip.append(icon, label);
  return chip;
}

/**
 * The path a click should open, or null if the click missed a chip or landed on
 * one that could not be resolved.
 *
 * Shared by the composer and the transcript so a chip responds the same way on
 * both — and it has to handle a click on the chip's icon, not just its text,
 * which is why it walks up with `closest`.
 */
export function openableChipPath(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const chip = target.closest(`[${CHIP_ATTR}="file"][data-openable="true"]`);
  return chip?.getAttribute("data-path") || null;
}

/** Where `save_chat_attachment` writes, keyed by chat thread id. */
export const CHAT_ATTACHMENT_DIR = ".context/archductor";

export function chatAttachmentPath(threadId: number, filename: string): string {
  return `${CHAT_ATTACHMENT_DIR}/${threadId}/${filename}`;
}

/**
 * Whether a label is a filename core wrote as a chat attachment.
 *
 * Core builds these as `<kebab-label>-<8 hex>.<ext>` (`save_chat_attachment`),
 * and that shape is specific enough to recognise without asking the daemon.
 */
export function isChatAttachmentFilename(label: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}\.(?:md|png)$/.test(label);
}

/**
 * Best known path for a chip, given only the filename the marker carries.
 *
 * A sent message stores `{filename}` and nothing else — deliberately, since the
 * marker grammar is what older history is already written in — so opening one
 * means recovering the path:
 *
 * 1. An attachment filename resolves against this thread's attachment
 *    directory. Pastes and saved action prompts both land there, and the path
 *    is computed rather than searched, so it works even though `.context/` is
 *    normally gitignored and therefore absent from the workspace file list.
 * 2. Otherwise a unique match in the workspace file list, which covers chips
 *    that began as `@file` mentions.
 * 3. Otherwise `null` — the chip renders exactly as it does today and simply
 *    does not respond to a click. `list_files` is capped and gitignore-filtered,
 *    so "not found" is common and must stay harmless.
 */
export function resolveChipPath(
  label: string,
  opts: { threadId?: number | null; files?: readonly string[] },
): string | null {
  if (opts.threadId != null && isChatAttachmentFilename(label)) {
    return chatAttachmentPath(opts.threadId, label);
  }
  const matches = (opts.files ?? []).filter(
    (path) => (path.split(/[\\/]/).filter(Boolean).at(-1) ?? path) === label,
  );
  return matches.length === 1 ? matches[0] : null;
}
