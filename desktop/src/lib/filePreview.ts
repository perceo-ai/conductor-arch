// Which files the viewer can render as something other than raw text. Named
// kinds rather than a boolean so image or HTML previews can be added later
// without reshaping the call site.

export type PreviewKind = "markdown";

const PREVIEW_BY_EXT: Record<string, PreviewKind> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
};

/** The preview available for a path, or null when there is only raw text. */
export function previewKind(path: string): PreviewKind | null {
  const base = path.split("/").pop() ?? "";
  if (!base.includes(".")) return null;
  const ext = base.split(".").pop()!.toLowerCase();
  return PREVIEW_BY_EXT[ext] ?? null;
}
