import {  prefsStore } from "@/store";
import { DEFAULT_SHORTCUTS, parseKeybindingOverrides } from "@/lib/shortcuts";

// Keybinding overrides are stored as a flat prefs map (one key per shortcut\n// index) rather than a nested object, so a single override round-trips through\n// the same string-valued prefs channel as everything else.
export function shortcutBindingKey(index: number): string {
  const binding = DEFAULT_SHORTCUTS[index];
  return binding.aliases?.[0] ?? binding.action;
}

export function serializeShortcutBindings(bindings: typeof DEFAULT_SHORTCUTS): string {
  return bindings
    .map((binding, index) => ({ binding, index }))
    .filter(({ binding }) => binding.keys.trim())
    .map(({ binding, index }) => `${shortcutBindingKey(index)}=${binding.keys.trim()}`)
    .join("; ");
}

export function setShortcutBinding(index: number, keys: string) {
  const current = parseKeybindingOverrides(prefsStore.state.keybindings, DEFAULT_SHORTCUTS);
  current[index] = { ...current[index], keys };
  prefsStore.setKeybindings(serializeShortcutBindings(current));
}
