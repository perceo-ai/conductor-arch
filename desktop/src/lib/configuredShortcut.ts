import { prefsStore } from "@/store/prefs";
import {
  parseKeybindingOverrides,
  shortcutForAction,
  type ShortcutAction,
} from "./shortcuts";

/** The display label for the user's current binding, suitable for data-shortcut. */
export function configuredShortcut(action: ShortcutAction): string | undefined {
  return shortcutForAction(action, parseKeybindingOverrides(prefsStore.state.keybindings));
}
