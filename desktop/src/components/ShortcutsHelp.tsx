import { For, Show } from "solid-js";
import { SHORTCUT_HELP } from "@/lib/shortcuts";

// Keyboard-shortcuts reference overlay (opened with "?"). Mirrors the GTK
// shortcuts window; the list is sourced from the same SHORTCUT_HELP table the
// resolver uses so keys and docs never drift.
export default function ShortcutsHelp(props: { open: boolean; onClose: () => void }) {
  return (
    <Show when={props.open}>
      <div class="cmdk-overlay" onClick={props.onClose}>
        <div class="shortcuts-panel" onClick={(e) => e.stopPropagation()}>
          <div class="shortcuts-head">
            <span class="section-title">Keyboard shortcuts</span>
            <button class="ui-button-icon" title="Close" onClick={props.onClose}>
              ×
            </button>
          </div>
          <div class="shortcuts-list">
            <For each={SHORTCUT_HELP}>
              {(row) => (
                <div class="shortcuts-row">
                  <kbd class="shortcuts-keys">{row.keys}</kbd>
                  <span class="shortcuts-label">{row.label}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}
