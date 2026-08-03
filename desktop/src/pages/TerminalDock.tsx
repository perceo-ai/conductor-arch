import { For, Show, createSignal } from "solid-js";
import { send } from "@/bridge/client";
import { terminalStore } from "@/store";
import TerminalPanel from "./TerminalPanel";

// Right-panel bottom region — port of the GTK run console (ws_run_console).
// A collapsible dock with a tab strip of PTY-backed terminals. Shells are
// spawned lazily (on first expand or "+"), so an unopened workspace never
// starts a process. Terminal panels stay mounted across tab switches to keep
// their xterm buffers and sessions alive; only the active tab is shown.

const MAX_TERMINALS = 6;

export default function TerminalDock(props: { workspace: string }) {
  // Expanded by default so the terminal dock is visible in the workspace panel
  // (matches the old GTK run console). Shells are still spawned lazily — the
  // dock shows an empty-state prompt until the first terminal is opened.
  const [expanded, setExpanded] = createSignal(true);
  const terms = () => terminalStore.terminals(props.workspace);
  const active = () => terminalStore.activeId(props.workspace);

  function addTerm() {
    if (terms().length >= MAX_TERMINALS) return;
    terminalStore.addTerminal(props.workspace);
    void send({ type: "spawn_session", workspace: props.workspace, kind: "shell" }).catch(() => {});
  }

  function closeTerm(tabId: string) {
    const sid = terminalStore.sessionId(props.workspace, tabId);
    if (sid != null) void send({ type: "kill_session", session_id: sid }).catch(() => {});
    terminalStore.removeTerminal(props.workspace, tabId);
  }

  function toggle() {
    const next = !expanded();
    setExpanded(next);
    if (next && terms().length === 0) addTerm();
  }

  return (
    <div class="ws-term-dock" classList={{ "ws-term-dock-expanded": expanded() }}>
      <div class="ws-term-tabbar">
        <For each={terms()}>
          {(t, i) => (
            <div
              class="ws-term-tab"
              classList={{ "ws-term-tab-active": active() === t.id }}
              onClick={() => {
                terminalStore.setActive(props.workspace, t.id);
                setExpanded(true);
              }}
            >
              <span class="ws-term-tab-label">Terminal {i() + 1}</span>
              <button
                class="ws-tab-close-button"
                title="Close terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerm(t.id);
                }}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <button
          class="ui-button-icon ws-term-add"
          title="New terminal"
          disabled={terms().length >= MAX_TERMINALS}
          onClick={addTerm}
        >
          +
        </button>
        <div class="ws-term-tabbar-spacer" />
        <button class="ui-button-icon ws-term-collapse" title={expanded() ? "Collapse" : "Expand"} onClick={toggle}>
          {expanded() ? "▾" : "▴"}
        </button>
      </div>
      <Show when={expanded()}>
        <div class="ws-term-body">
          <For each={terms()}>
            {(t) => (
              <div class="ws-term-pane" classList={{ "ws-term-pane-hidden": active() !== t.id }}>
                <TerminalPanel workspace={props.workspace} tabId={t.id} />
              </div>
            )}
          </For>
          <Show when={terms().length === 0}>
            <div class="empty-state">No terminals. Press + to open one.</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
