// Global keyboard-shortcut resolver. Pure so the keymap is unit-testable; App
// wires the returned action id to the actual handlers. Uses Cmd on Mac and Ctrl
// elsewhere (the caller passes whichever modifier is pressed via `mod`).

export type ShortcutAction =
  | "toggle-sidebar"
  | "nav-back"
  | "nav-forward"
  | "open-palette"
  | "goto-dashboard"
  | "goto-history"
  | "goto-settings"
  | "show-help"
  | "new-workspace"
  | "show-changes"
  | "create-pr"
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
  | "toggle-terminal";

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface ShortcutBinding {
  action: ShortcutAction;
  keys: string;
  label: string;
  aliases?: string[];
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { action: "open-palette", keys: "mod+k", label: "Command palette", aliases: ["palette"] },
  { action: "new-workspace", keys: "mod+shift+n", label: "New workspace", aliases: ["new"] },
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
  { action: "focus-composer", keys: "mod+j", label: "Focus chat composer", aliases: ["focus"] },
  { action: "focus-workspace", keys: "mod+l", label: "Focus workspace", aliases: ["workspace"] },
  { action: "focus-search", keys: "mod+f", label: "Focus sidebar", aliases: ["search", "focus-sidebar"] },
  { action: "next-panel", keys: "mod+arrowright", label: "Next workspace panel", aliases: ["next"] },
  { action: "prev-panel", keys: "mod+arrowleft", label: "Previous workspace panel", aliases: ["previous", "prev"] },
  { action: "next-workspace", keys: "mod+arrowdown", label: "Next workspace", aliases: ["next-workspace"] },
  { action: "prev-workspace", keys: "mod+arrowup", label: "Previous workspace", aliases: ["prev-workspace", "previous-workspace"] },
  { action: "workspace-actions", keys: "mod+shift+a", label: "Workspace actions", aliases: ["actions", "workspace-actions"] },
  { action: "add-project", keys: "mod+shift+o", label: "Add project", aliases: ["add-project", "project"] },
  { action: "new-chat", keys: "mod+shift+c", label: "New chat", aliases: ["chat", "new-chat"] },
  { action: "toggle-terminal", keys: "mod+`", label: "Toggle terminal dock", aliases: ["terminal", "dock"] },
  { action: "toggle-sidebar", keys: "mod+b", label: "Toggle sidebar", aliases: ["sidebar"] },
  { action: "nav-back", keys: "mod+[", label: "Navigate back", aliases: ["back"] },
  { action: "nav-forward", keys: "mod+]", label: "Navigate forward", aliases: ["forward"] },
  { action: "goto-dashboard", keys: "mod+1", label: "Dashboard", aliases: ["dashboard"] },
  { action: "goto-history", keys: "mod+2", label: "History", aliases: ["history"] },
  { action: "goto-settings", keys: "mod+3", label: "Settings", aliases: ["settings"] },
  { action: "goto-settings", keys: "mod+,", label: "Settings", aliases: ["preferences"] },
  { action: "show-help", keys: "mod+/", label: "Keyboard shortcuts", aliases: ["help", "shortcuts"] },
  { action: "save", keys: "mod+s", label: "Save", aliases: ["save"] },
  { action: "send-immediate", keys: "mod+enter", label: "Send immediately", aliases: ["send", "steer"] },
];

export type ShortcutMap = ShortcutBinding[];

function actionForName(name: string): ShortcutAction | null {
  const normalized = name.trim().toLowerCase().replaceAll("_", "-");
  for (const binding of DEFAULT_SHORTCUTS) {
    if (binding.action === normalized || binding.aliases?.includes(normalized)) {
      return binding.action;
    }
  }
  return null;
}

function normalizeKeyName(key: string): string {
  const lower = key.trim().toLowerCase();
  if (lower === "cmd" || lower === "command" || lower === "meta") return "meta";
  if (lower === "control" || lower === "ctl") return "ctrl";
  if (lower === "option") return "alt";
  if (lower === "esc") return "escape";
  if (lower === "left") return "arrowleft";
  if (lower === "right") return "arrowright";
  if (lower === "up") return "arrowup";
  if (lower === "down") return "arrowdown";
  return lower;
}

function normalizeChord(chord: string): string | null {
  const raw = chord.trim();
  if (!raw) return null;
  if (raw === "?") return "?";
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
  const ordered = ["mod", "shift", "alt"].filter((part) => modifiers.has(part));
  return [...ordered, key].join("+");
}

function eventChord(e: KeyEventLike): string {
  const key = normalizeKeyName(e.key);
  if (key === "?") return "?";
  const modifiers: string[] = [];
  if (e.ctrlKey || e.metaKey) modifiers.push("mod");
  if (e.shiftKey) modifiers.push("shift");
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
  const byAction = new Map<ShortcutAction, number>();
  const seenActions = new Set<ShortcutAction>();
  next.forEach((binding, index) => {
    if (!byAction.has(binding.action)) byAction.set(binding.action, index);
  });
  for (const part of splitOverrideEntries(raw)) {
    const [name, ...rest] = part.split("=");
    if (!name || rest.length === 0) continue;
    const action = actionForName(name);
    const keys = normalizeChord(rest.join("=").trim());
    if (!action || !keys) continue;
    const index = byAction.get(action);
    if (index == null) continue;
    if (!seenActions.has(action)) {
      for (let i = 0; i < next.length; i += 1) {
        if (next[i].action === action) next[i] = { ...next[i], keys: "" };
      }
      seenActions.add(action);
    }
    for (let i = 0; i < next.length; i += 1) {
      if (i !== index && next[i].keys === keys) next[i] = { ...next[i], keys: "" };
    }
    next[index] = { ...next[index], keys };
  }
  return next;
}

export function resolveShortcut(e: KeyEventLike, shortcuts: ShortcutMap = DEFAULT_SHORTCUTS): ShortcutAction | null {
  const chord = eventChord(e);
  const binding = shortcuts.find((candidate) => candidate.keys === chord);
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
