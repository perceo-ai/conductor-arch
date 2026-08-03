import Anser from "anser";

// Convert shell/process output containing ANSI escape codes into styled HTML so
// terminal output in inline command/process cards looks like a terminal (colors,
// bold, dim) instead of raw \x1b[... sequences. Uses inline styles so it needs
// no extra CSS. Input is escaped by anser (use_classes:false + json→html path).

export function ansiToHtml(text: string): string {
  try {
    return Anser.ansiToHtml(text, { use_classes: false });
  } catch {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}
