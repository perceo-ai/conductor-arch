import { marked } from "marked";
import { highlightCode, escapeHtml } from "./highlight";

// Render assistant message markdown to HTML with fenced code blocks
// syntax-highlighted (so ```tsx / ```py blocks look like editor code). marked is
// synchronous here (no async extensions), so the returned string can go straight
// into innerHTML. Output is model text rendered in a trusted desktop shell; we
// still escape code and rely on marked's default escaping for inline HTML.

marked.setOptions({ gfm: true, breaks: true });

marked.use({
  renderer: {
    code(this: unknown, token: { text: string; lang?: string }) {
      const lang = (token.lang ?? "").trim().split(/\s+/)[0] || undefined;
      const html = highlightCode(token.text, lang);
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      return `<pre class="md-code hljs"><code${cls}>${html}</code></pre>`;
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
