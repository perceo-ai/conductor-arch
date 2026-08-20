// Markdown rendered from agent output goes through innerHTML, so `[x](https://…)`
// becomes a real <a href>. Left alone, clicking it navigates the renderer itself
// away from the app shell — the SPA is replaced by the remote page and there is
// no back button in a frameless window. Intercept those clicks and hand the URL
// to the OS browser instead.
//
// Only explicitly-schemed http(s)/mailto targets qualify. Relative hrefs are
// left to the app (they resolve against the dev server or file:// document, so
// resolving them here would misclassify them differently in dev vs packaged),
// and javascript:/data:/file: are refused outright — this input is untrusted
// agent output and shell.openExternal hands it straight to the OS.

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

/**
 * Delegate clicks on the document so every rendered link — chat markdown, plan
 * cards, briefings — routes through `open`. Returns a disposer.
 */
export function installExternalLinkHandler(doc: Document, open: (url: string) => void): () => void {
  const onClick = (event: Event) => {
    const evt = event as MouseEvent;
    // Plain primary click only: modified clicks and middle clicks are the user
    // asking the platform for its own behavior, not an in-app navigation.
    if (evt.button !== 0 || evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return;
    if (evt.defaultPrevented) return;
    const anchor = (evt.target as Element | null)?.closest?.("a[href]");
    const url = externalHref(anchor?.getAttribute("href"));
    if (!url) return;
    evt.preventDefault();
    open(url);
  };
  doc.addEventListener("click", onClick);
  return () => doc.removeEventListener("click", onClick);
}
