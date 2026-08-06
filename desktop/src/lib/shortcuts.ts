// Global keyboard-shortcut resolver. Pure so the keymap is unit-testable; App
// wires the returned action id to the actual handlers. Uses Cmd on Mac and Ctrl
// elsewhere (the caller passes whichever modifier is pressed via `mod`).

export type ShortcutAction =
  | "toggle-sidebar"
  | "nav-back"
  | "nav-forward"
  | "open-palette"
  | "goto-dashboard"
  | "goto-projects"
  | "goto-history"
  | "goto-settings"
  | "show-help";

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

// The primary modifier is Cmd on Mac, Ctrl elsewhere. We accept either being
// held so the same table works cross-platform.
function hasMod(e: KeyEventLike): boolean {
  return e.ctrlKey || e.metaKey;
}

export function resolveShortcut(e: KeyEventLike): ShortcutAction | null {
  // "?" help works without a modifier (Shift+/ on most layouts) and with the
  // primary modifier for keyboards where "?" needs it.
  if (e.key === "?" ) return "show-help";

  if (!hasMod(e)) return null;
  switch (e.key) {
    case "b":
    case "B":
      return "toggle-sidebar";
    case "[":
      return "nav-back";
    case "]":
      return "nav-forward";
    case "k":
    case "K":
      return "open-palette";
    case ",":
      return "goto-settings";
    case "1":
      return "goto-dashboard";
    case "2":
      return "goto-projects";
    case "3":
      return "goto-history";
    case "4":
      return "goto-settings";
    default:
      return null;
  }
}

// Human-readable table for the shortcuts-help overlay. Kept next to the resolver
// so the two never drift.
export const SHORTCUT_HELP: { keys: string; label: string }[] = [
  { keys: "⌘/Ctrl K", label: "Command palette" },
  { keys: "⌘/Ctrl B", label: "Toggle sidebar" },
  { keys: "⌘/Ctrl [", label: "Navigate back" },
  { keys: "⌘/Ctrl ]", label: "Navigate forward" },
  { keys: "⌘/Ctrl 1–4", label: "Dashboard / Projects / History / Settings" },
  { keys: "⌘/Ctrl ,", label: "Settings" },
  { keys: "?", label: "This shortcuts help" },
  { keys: "Esc", label: "Close overlay / palette" },
];
