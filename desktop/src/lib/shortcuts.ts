// Global keyboard-shortcut resolver. Pure so the keymap is unit-testable; App
// wires the returned action id to the actual handlers. Uses Cmd on Mac and Ctrl
// elsewhere (the caller passes whichever modifier is pressed via `mod`).

type WorkspaceSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type ShortcutAction =
  | "toggle-sidebar"
  | "toggle-right-panel"
  | "toggle-theme"
  | "nav-back"
  | "nav-forward"
  | "open-palette"
  | "quick-open"
  | "goto-dashboard"
  | "goto-history"
  | "goto-settings"
  | "show-help"
  | "new-workspace"
  | "archive-workspace"
  | "show-changes"
  | "show-uncommitted"
  | "show-files"
  | "show-checks"
  | "show-summary"
  | "create-pr"
  | "merge-pr"
  | "push-branch"
  | "open-pr-github"
  | "start-review"
  | "focus-composer"
  | "focus-workspace"
  | "focus-search"
  | "next-panel"
  | "prev-panel"
  | "next-workspace"
  | "prev-workspace"
  | "save"
  | "send-immediate"
  | "workspace-actions"
  | "add-project"
  | "new-chat"
  | "toggle-terminal"
  | "open-in-app"
  | "open-menu"
  | "copy-link"
  | "toggle-plan-mode"
  | "approve-plan"
  | "edit-layout"
  | `switch-workspace-${WorkspaceSlot}`;

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}

export interface ShortcutBinding {
  action: ShortcutAction;
  keys: string;
  label: string;
  aliases?: string[];
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { action: "open-palette", keys: "mod+k", label: "Command palette", aliases: ["palette"] },
  { action: "quick-open", keys: "mod+p", label: "Quick open file", aliases: ["quick-open", "open-file"] },
  { action: "toggle-theme", keys: "mod+alt+t", label: "Toggle theme", aliases: ["theme"] },
  { action: "new-workspace", keys: "mod+n", label: "New workspace", aliases: ["new"] },
  { action: "new-workspace", keys: "mod+shift+n", label: "New workspace", aliases: ["new-workspace"] },
  {
    action: "show-changes",
    keys: "mod+shift+d",
    label: "Show changes / diff",
    aliases: ["changes", "diff"],
  },
  {
    action: "create-pr",
    keys: "mod+shift+p",
    label: "Create / refresh pull request",
    aliases: ["pr"],
  },
  { action: "archive-workspace", keys: "mod+shift+a", label: "Archive workspace", aliases: ["archive"] },
  { action: "merge-pr", keys: "mod+shift+m", label: "Merge pull request", aliases: ["merge"] },
  { action: "push-branch", keys: "mod+shift+y", label: "Push branch", aliases: ["push"] },
  { action: "open-pr-github", keys: "mod+shift+g", label: "Open PR in GitHub", aliases: ["github"] },
  { action: "start-review", keys: "mod+shift+r", label: "Start review", aliases: ["review"] },
  { action: "edit-layout", keys: "mod+shift+l", label: "Edit layout", aliases: ["edit-layout", "layout-edit"] },
  { action: "focus-composer", keys: "mod+l", label: "Focus chat input", aliases: ["focus"] },
  { action: "focus-workspace", keys: "mod+alt+l", label: "Focus workspace", aliases: ["workspace"] },
  { action: "focus-search", keys: "mod+f", label: "Focus sidebar", aliases: ["search", "focus-sidebar"] },
  { action: "next-panel", keys: "mod+shift+]", label: "Next tab", aliases: ["next"] },
  { action: "next-panel", keys: "mod+alt+arrowright", label: "Next tab", aliases: ["next-panel"] },
  { action: "prev-panel", keys: "mod+shift+[", label: "Previous tab", aliases: ["previous", "prev"] },
  { action: "prev-panel", keys: "mod+alt+arrowleft", label: "Previous tab", aliases: ["prev-panel"] },
  { action: "next-workspace", keys: "mod+alt+arrowdown", label: "Next workspace", aliases: ["next-workspace"] },
  { action: "prev-workspace", keys: "mod+alt+arrowup", label: "Previous workspace", aliases: ["prev-workspace", "previous-workspace"] },
  { action: "workspace-actions", keys: "mod+shift+alt+a", label: "Workspace actions", aliases: ["actions", "workspace-actions"] },
  { action: "add-project", keys: "mod+alt+a", label: "Add repository", aliases: ["add-project", "project"] },
  { action: "new-chat", keys: "mod+t", label: "New chat tab", aliases: ["chat", "new-chat"] },
  { action: "toggle-terminal", keys: "mod+j", label: "Toggle terminal panel", aliases: ["terminal", "dock"] },
  { action: "toggle-sidebar", keys: "mod+b", label: "Toggle sidebar", aliases: ["sidebar"] },
  { action: "toggle-right-panel", keys: "mod+alt+b", label: "Toggle right sidebar", aliases: ["right-sidebar", "right-panel"] },
  { action: "nav-back", keys: "mod+[", label: "Navigate back", aliases: ["back"] },
  { action: "nav-forward", keys: "mod+]", label: "Navigate forward", aliases: ["forward"] },
  { action: "switch-workspace-1", keys: "mod+1", label: "Switch to workspace 1", aliases: ["workspace-1"] },
  { action: "switch-workspace-2", keys: "mod+2", label: "Switch to workspace 2", aliases: ["workspace-2"] },
  { action: "switch-workspace-3", keys: "mod+3", label: "Switch to workspace 3", aliases: ["workspace-3"] },
  { action: "switch-workspace-4", keys: "mod+4", label: "Switch to workspace 4", aliases: ["workspace-4"] },
  { action: "switch-workspace-5", keys: "mod+5", label: "Switch to workspace 5", aliases: ["workspace-5"] },
  { action: "switch-workspace-6", keys: "mod+6", label: "Switch to workspace 6", aliases: ["workspace-6"] },
  { action: "switch-workspace-7", keys: "mod+7", label: "Switch to workspace 7", aliases: ["workspace-7"] },
  { action: "switch-workspace-8", keys: "mod+8", label: "Switch to workspace 8", aliases: ["workspace-8"] },
  { action: "switch-workspace-9", keys: "mod+9", label: "Switch to workspace 9", aliases: ["workspace-9"] },
  { action: "goto-dashboard", keys: "", label: "Dashboard", aliases: ["dashboard"] },
  { action: "goto-history", keys: "", label: "History", aliases: ["history"] },
  { action: "goto-settings", keys: "", label: "Settings", aliases: ["settings"] },
  { action: "goto-settings", keys: "mod+,", label: "Settings", aliases: ["preferences"] },
  { action: "show-help", keys: "mod+/", label: "Keyboard shortcuts", aliases: ["help", "shortcuts"] },
  { action: "open-in-app", keys: "mod+o", label: "Open in app", aliases: ["open"] },
  { action: "open-menu", keys: "mod+shift+o", label: "Open in menu", aliases: ["open-menu"] },
  { action: "copy-link", keys: "mod+shift+c", label: "Copy link", aliases: ["copy-link", "copy"] },
  { action: "show-uncommitted", keys: "mod+alt+c", label: "Show uncommitted changes", aliases: ["uncommitted"] },
  { action: "show-files", keys: "mod+alt+f", label: "Show files", aliases: ["files"] },
  { action: "show-checks", keys: "mod+shift+alt+c", label: "Show checks", aliases: ["checks"] },
  { action: "show-summary", keys: "mod+alt+n", label: "Show notes", aliases: ["notes", "summary"] },
  { action: "toggle-plan-mode", keys: "mod+shift+tab", label: "Toggle plan mode", aliases: ["plan"] },
  { action: "approve-plan", keys: "mod+shift+enter", label: "Approve plan", aliases: ["approve"] },
  { action: "save", keys: "mod+s", label: "Save", aliases: ["save"] },
  { action: "send-immediate", keys: "mod+enter", label: "Send immediately", aliases: ["send", "steer"] },
];

export type ShortcutMap = ShortcutBinding[];

function bindingTargetForName(name: string, bindings: ShortcutMap): { index: number; clearSameAction: boolean } | null {
  const normalized = name.trim().toLowerCase().replaceAll("_", "-");
  const aliasIndex = bindings.findIndex((binding) => binding.aliases?.includes(normalized));
  if (aliasIndex >= 0) return { index: aliasIndex, clearSameAction: false };
  const actionIndex = bindings.findIndex((binding) => binding.action === normalized);
  if (actionIndex >= 0) return { index: actionIndex, clearSameAction: true };
  return null;
}

function normalizeKeyName(key: string): string {
  const lower = key.toLowerCase();
  if (lower === " ") return "space";
  const trimmed = lower.trim();
  if (trimmed === "space" || trimmed === "spacebar") return "space";
  if (!trimmed) return "";
  if (trimmed === "cmd" || trimmed === "command" || trimmed === "meta") return "meta";
  if (trimmed === "control" || trimmed === "ctl") return "ctrl";
  if (trimmed === "option") return "alt";
  if (trimmed === "esc") return "escape";
  if (trimmed === "left") return "arrowleft";
  if (trimmed === "right") return "arrowright";
  if (trimmed === "up") return "arrowup";
  if (trimmed === "down") return "arrowdown";
  return trimmed;
}

function normalizeChord(chord: string): string | null {
  const raw = chord.trim();
  if (!raw) return null;
  const parts = raw.split("+").map(normalizeKeyName).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.at(-1);
  if (!key || ["mod", "ctrl", "meta", "shift", "alt"].includes(key)) return null;
  const modifiers = new Set(parts.slice(0, -1));
  if (![...modifiers].every((part) => ["mod", "ctrl", "meta", "shift", "alt"].includes(part))) {
    return null;
  }
  if (modifiers.has("ctrl") || modifiers.has("meta")) {
    modifiers.add("mod");
    modifiers.delete("ctrl");
    modifiers.delete("meta");
  }
  if (!modifiers.has("mod")) return null;
  const ordered = ["mod", "shift", "alt"].filter((part) => modifiers.has(part));
  return [...ordered, key].join("+");
}

function eventChord(e: KeyEventLike): string {
  const key = normalizeKeyName(e.key);
  if (key === "?") return "?";
  const modifiers: string[] = [];
  if (e.ctrlKey || e.metaKey) modifiers.push("mod");
  if (e.shiftKey) modifiers.push("shift");
  if (e.altKey) modifiers.push("alt");
  return [...modifiers, key].join("+");
}

function splitOverrideEntries(raw: string): string[] {
  return raw
    .split(/[\n;]/)
    .flatMap((chunk) => {
      const entries: string[] = [];
      let start = 0;
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] !== ",") continue;
        const tail = chunk.slice(i + 1);
        if (/^\s*[\w-]+\s*=/.test(tail)) {
          entries.push(chunk.slice(start, i));
          start = i + 1;
        }
      }
      entries.push(chunk.slice(start));
      return entries;
    })
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseKeybindingOverrides(raw: string | undefined, base: ShortcutMap = DEFAULT_SHORTCUTS): ShortcutMap {
  const next = base.map((binding) => ({ ...binding }));
  if (!raw?.trim()) return next;
  const seenActions = new Set<ShortcutAction>();
  for (const part of splitOverrideEntries(raw)) {
    const [name, ...rest] = part.split("=");
    if (!name || rest.length === 0) continue;
    const target = bindingTargetForName(name, next);
    const keys = normalizeChord(rest.join("=").trim());
    if (!target || !keys) continue;
    const action = next[target.index].action;
    if (target.clearSameAction && !seenActions.has(action)) {
      for (let i = 0; i < next.length; i += 1) {
        if (next[i].action === action) next[i] = { ...next[i], keys: "" };
      }
      seenActions.add(action);
    }
    for (let i = 0; i < next.length; i += 1) {
      if (i !== target.index && next[i].keys === keys) next[i] = { ...next[i], keys: "" };
    }
    next[target.index] = { ...next[target.index], keys };
  }
  return next;
}

export function resolveShortcut(e: KeyEventLike, shortcuts: ShortcutMap = DEFAULT_SHORTCUTS): ShortcutAction | null {
  const chord = eventChord(e);
  const binding = shortcuts.find((candidate) => candidate.keys && candidate.keys === chord);
  return binding?.action ?? null;
}

export function formatShortcutKeys(keys: string): string {
  if (keys === "?") return "?";
  return keys
    .split("+")
    .map((part) => {
      if (part === "mod") return "⌘/Ctrl";
      if (part === "ctrl") return "Ctrl";
      if (part === "meta") return "⌘";
      if (part === "shift") return "⇧";
      if (part === "alt") return "Alt";
      if (part === "arrowleft") return "←";
      if (part === "arrowright") return "→";
      if (part === "arrowup") return "↑";
      if (part === "arrowdown") return "↓";
      return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function shortcutForAction(
  action: ShortcutAction,
  shortcuts: ShortcutMap = DEFAULT_SHORTCUTS,
): string | undefined {
  const binding = shortcuts.find((candidate) => candidate.action === action && candidate.keys);
  return binding ? formatShortcutKeys(binding.keys) : undefined;
}

export function shortcutHelp(shortcuts: ShortcutMap = DEFAULT_SHORTCUTS): { keys: string; label: string }[] {
  return shortcuts
    .filter((binding) => binding.keys)
    .map((binding) => ({ keys: formatShortcutKeys(binding.keys), label: binding.label }));
}

// Human-readable table for the shortcuts-help overlay. Kept next to the resolver
// so the two never drift.
export const SHORTCUT_HELP: { keys: string; label: string }[] = [
  ...shortcutHelp(DEFAULT_SHORTCUTS),
  { keys: "Esc", label: "Close overlay / palette" },
];
