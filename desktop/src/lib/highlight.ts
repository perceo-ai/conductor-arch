import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";

// Syntax highlighting helpers. highlight.js is synchronous, which lets us
// highlight diff rows one line at a time inside Solid's JSX without async
// juggling. The "common" bundle registers the popular languages (ts, js, py,
// rust, go, json, css, bash, …) and keeps the bundle far smaller than the full
// build.

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Map a file path (or bare language token) to a highlight.js language id. */
export function langFromPath(path: string): string | undefined {
  const base = path.split("/").pop() ?? path;
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  if (base.toLowerCase() === "makefile") return "makefile";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : base.toLowerCase();
  const lang = EXT_TO_LANG[ext];
  return lang && hljs.getLanguage(lang) ? lang : undefined;
}

/** Highlight a full code block, returning inner HTML (no wrapper). */
export function highlightCode(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Highlight a single line for a diff row. Per-line highlighting loses multi-line
 * context (open strings/comments), but keeps the diff gutter simple and is good
 * enough for a viewer. Falls back to escaped text when the language is unknown.
 */
export function highlightLine(line: string, lang?: string): string {
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(line);
  try {
    return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(line);
  }
}
