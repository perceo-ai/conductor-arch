// Main-process backstop for links that escape the renderer's click handler
// (target="_blank", window.open, a redirect chain). Without these guards a web
// URL either replaces the app shell in place or opens a chrome-less Electron
// window with no way back.

const EXTERNAL_SCHEME_RE = /^(?:https?|mailto):/i;

/** Schemes we are willing to hand to `shell.openExternal`. */
export function isExternalOpenTarget(url: string): boolean {
  return !!url && EXTERNAL_SCHEME_RE.test(url);
}

function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The URL to open in the OS browser for a navigation attempt, or null when the
 * navigation is the app loading itself (packaged `file://` document, or the
 * Vite dev server) or uses a scheme we refuse to forward.
 */
export function externalNavigationUrl(url: string, devServerUrl: string | null): string | null {
  if (!isExternalOpenTarget(url)) return null;
  const devOrigin = devServerUrl ? origin(devServerUrl) : null;
  if (devOrigin && origin(url) === devOrigin) return null;
  return url;
}
