// Markdown rendered from agent output goes through innerHTML, so `[x](https://…)`
// becomes a real <a href>. Left alone, clicking it navigates the renderer itself
// away from the app shell — the SPA is replaced by the remote page and there is
// no back button in a frameless window. Intercept those clicks and hand the URL
// to the OS browser instead.
//
// Only explicitly-schemed http(s)/mailto targets go to the OS. Agents also link
// files (`[main.ts](src/main.ts)`, `/abs/path/main.ts`, `file:///…`); those
// would resolve against the dev server or the packaged file:// document and
// replace the app with a raw file view, so they are routed to the in-app file
// tab instead. javascript:/data: and the like are refused outright — this input
// is untrusted agent output and shell.openExternal hands it straight to the OS.

const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function externalHref(raw: string | null | undefined): string | null {
  const href = raw?.trim();
  if (!href) return null;
  let scheme: string;
  try {
    scheme = new URL(href).protocol;
  } catch {
    return null; // relative or malformed — not ours to open
  }
  return EXTERNAL_SCHEMES.has(scheme) ? href : null;
}

const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/;
const DRIVE_RE = /^[A-Za-z]:\//;

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * The workspace-relative path a local link in agent markdown points at, or
 * null when it is not a file inside `root`. Accepts relative paths, absolute
 * paths under the workspace, and file:// URLs; drops `#L12` and `:12:4` line
 * suffixes, which the file tab has no way to honour yet.
 */
export function workspaceFilePath(raw: string | null | undefined, root: string | null | undefined): string | null {
  const href = raw?.trim();
  if (!href || href.startsWith("#")) return null;
  let path: string;
  if (/^file:/i.test(href)) {
    try {
      path = safeDecode(new URL(href).pathname);
    } catch {
      return null;
    }
    // file:///C:/x parses to "/C:/x".
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(href)) {
    return null; // some other scheme — never a workspace file
  } else {
    path = safeDecode(href.split(/[?#]/)[0]);
  }
  path = normalizeSeparators(path).replace(LINE_SUFFIX_RE, "");

  let relative: string;
  if (path.startsWith("/") || DRIVE_RE.test(path)) {
    if (!root) return null;
    const base = normalizeSeparators(root).replace(/\/+$/, "");
    const caseless = DRIVE_RE.test(base);
    const inside = caseless
      ? path.toLowerCase().startsWith(`${base.toLowerCase()}/`)
      : path.startsWith(`${base}/`);
    if (!inside) return null;
    relative = path.slice(base.length + 1);
  } else {
    relative = path;
  }

  const parts: string[] = [];
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null; // escapes the workspace
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length ? parts.join("/") : null;
}

/**
 * Delegate clicks on the document so every rendered link — chat markdown, plan
 * cards, briefings — routes through `open` (web links) or `openLocal` (anything
 * that looks like a file path). No rendered link is ever allowed to navigate
 * the renderer; in-page `#fragment` links are the one exception. Returns a
 * disposer.
 */
export function installExternalLinkHandler(
  doc: Document,
  open: (url: string) => void,
  openLocal?: (href: string) => void,
): () => void {
  const onClick = (event: Event) => {
    const evt = event as MouseEvent;
    // Plain primary click only: modified clicks and middle clicks are the user
    // asking the platform for its own behavior, not an in-app navigation.
    if (evt.button !== 0 || evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return;
    if (evt.defaultPrevented) return;
    const anchor = (evt.target as Element | null)?.closest?.("a[href]");
    const href = anchor?.getAttribute("href")?.trim();
    if (!href || href.startsWith("#")) return;
    evt.preventDefault();
    const url = externalHref(href);
    if (url) open(url);
    else if (/^file:/i.test(href) || !/^[A-Za-z][A-Za-z0-9+.-]+:/.test(href)) openLocal?.(href);
  };
  doc.addEventListener("click", onClick);
  return () => doc.removeEventListener("click", onClick);
}
