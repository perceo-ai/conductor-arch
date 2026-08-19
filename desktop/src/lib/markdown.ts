import { marked } from "marked";
import { highlightCode, escapeHtml } from "./highlight";

// Render assistant message markdown to HTML with fenced code blocks
// syntax-highlighted (so ```tsx / ```py blocks look like editor code). marked is
// synchronous here (no async extensions), so the returned string can go straight
// into innerHTML.
//
// SECURITY: the input is untrusted LLM output and the result is assigned via
// innerHTML. marked (gfm) passes raw inline/block HTML through verbatim — it has
// no built-in sanitizer — so an agent reply containing `<img src=x onerror=…>`
// would execute in the renderer. We override the `html` renderer to escape all
// raw HTML tokens (block and inline), neutralizing script/handler injection
// without pulling in a DOM-dependent sanitizer.

marked.setOptions({ gfm: true, breaks: true });

marked.use({
  renderer: {
    code(this: unknown, token: { text: string; lang?: string }) {
      const lang = (token.lang ?? "").trim().split(/\s+/)[0] || undefined;
      const html = highlightCode(token.text, lang);
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      return `<pre class="md-code hljs"><code${cls}>${html}</code></pre>`;
    },
    // Escape raw HTML instead of emitting it verbatim (XSS guard).
    html(this: unknown, token: string | { text?: string; raw?: string }) {
      const raw = typeof token === "string" ? token : token.text ?? token.raw ?? "";
      return escapeHtml(raw);
    },
  },
});

export function renderMarkdown(md: string): string {
  try {
    return marked.parse(md) as string;
  } catch {
    return escapeHtml(md);
  }
}

const INLINE_FILE_MARKER =
  /\{([A-Za-z0-9_.@+ -]+\.(?:c|cc|cpp|css|gif|go|h|hpp|html|jpeg|jpg|js|jsx|json|md|pdf|png|py|rs|scss|sh|sql|toml|ts|tsx|txt|webp|ya?ml))\}/g;

export function renderMarkdownWithInlineFileChips(md: string): string {
  return renderMarkdown(md).replace(INLINE_FILE_MARKER, (_match, label: string) => {
    const safe = escapeHtml(label);
    return `<span class="chat-inline-file-chip" title="${safe}">${safe}</span>`;
  });
}
