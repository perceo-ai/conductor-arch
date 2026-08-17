export type FileIconKind =
  | "astro"
  | "css"
  | "docker"
  | "git"
  | "html"
  | "image"
  | "javascript"
  | "json"
  | "lock"
  | "markdown"
  | "package"
  | "rust"
  | "shell"
  | "text"
  | "toml"
  | "typescript"
  | "yaml"
  | "config"
  | "file";

export interface FileIconMeta {
  label: string;
  kind: FileIconKind;
  title: string;
}

const byExtension: Record<string, FileIconMeta> = {
  astro: { label: "A", kind: "astro", title: "Astro" },
  bash: { label: "$", kind: "shell", title: "Shell" },
  cjs: { label: "JS", kind: "javascript", title: "JavaScript" },
  css: { label: "#", kind: "css", title: "CSS" },
  gif: { label: "IMG", kind: "image", title: "Image" },
  htm: { label: "<>", kind: "html", title: "HTML" },
  html: { label: "<>", kind: "html", title: "HTML" },
  icns: { label: "IMG", kind: "image", title: "Image" },
  ico: { label: "IMG", kind: "image", title: "Image" },
  jpeg: { label: "IMG", kind: "image", title: "Image" },
  jpg: { label: "IMG", kind: "image", title: "Image" },
  js: { label: "JS", kind: "javascript", title: "JavaScript" },
  json: { label: "{}", kind: "json", title: "JSON" },
  jsx: { label: "JSX", kind: "javascript", title: "JavaScript JSX" },
  lock: { label: "L", kind: "lock", title: "Lockfile" },
  md: { label: "MD", kind: "markdown", title: "Markdown" },
  mdx: { label: "MDX", kind: "markdown", title: "MDX" },
  mjs: { label: "JS", kind: "javascript", title: "JavaScript" },
  png: { label: "IMG", kind: "image", title: "Image" },
  rs: { label: "RS", kind: "rust", title: "Rust" },
  sh: { label: "$", kind: "shell", title: "Shell" },
  svg: { label: "SVG", kind: "image", title: "SVG" },
  toml: { label: "TM", kind: "toml", title: "TOML" },
  ts: { label: "TS", kind: "typescript", title: "TypeScript" },
  tsx: { label: "TSX", kind: "typescript", title: "TypeScript TSX" },
  txt: { label: "TXT", kind: "text", title: "Text" },
  yaml: { label: "YA", kind: "yaml", title: "YAML" },
  yml: { label: "YA", kind: "yaml", title: "YAML" },
  zsh: { label: "$", kind: "shell", title: "Shell" },
};

const byName: Record<string, FileIconMeta> = {
  ".dockerignore": { label: "D", kind: "docker", title: "Docker" },
  ".env": { label: "ENV", kind: "config", title: "Environment" },
  ".gitignore": { label: "G", kind: "git", title: "Git" },
  "cargo.lock": { label: "RS", kind: "lock", title: "Cargo lockfile" },
  "cargo.toml": { label: "RS", kind: "rust", title: "Cargo manifest" },
  dockerfile: { label: "D", kind: "docker", title: "Dockerfile" },
  license: { label: "LIC", kind: "text", title: "License" },
  makefile: { label: "MK", kind: "config", title: "Makefile" },
  "package.json": { label: "PKG", kind: "package", title: "Package manifest" },
  "pnpm-lock.yaml": { label: "L", kind: "lock", title: "pnpm lockfile" },
  readme: { label: "MD", kind: "markdown", title: "Readme" },
};

export function fileIconFor(path: string): FileIconMeta {
  const segments = path.split("/").filter(Boolean);
  const name = segments.at(-1)?.toLowerCase() ?? "";
  const exact = byName[name];
  if (exact) return exact;

  const extension = name.includes(".") ? name.split(".").pop() : "";
  if (extension) {
    const known = byExtension[extension];
    if (known) return known;
  }

  if (segments.some((segment) => segment.startsWith("."))) return { label: "CFG", kind: "config", title: "Config" };
  return { label: "", kind: "file", title: "File" };
}
