import { createEffect, onCleanup, onMount } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { send } from "@/bridge/client";
import { terminalStore } from "@/store";

// A single terminal tab — port of terminal.rs. The shell session (archcar
// SpawnSession kind=shell) owns the PTY in core; this renders its screen via
// xterm.js and forwards keystrokes with SendInput raw_terminal. The session is
// spawned by the dock and correlated to this tab in the store; here we just
// render the tab's screen and forward io once a session id exists.

export default function TerminalPanel(props: { workspace: string; tabId: string }) {
  let host!: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let lastScreen = "";

  onMount(() => {
    term = new Terminal({
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      fontSize: 13,
      theme: { background: "#151515", foreground: "#d4d4d4" },
      cursorBlink: true,
      convertEol: true,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    term.onData((data) => {
      const sid = terminalStore.sessionId(props.workspace, props.tabId);
      if (sid == null) return;
      void send({ type: "send_input", session_id: sid, input: data, kind: "raw_terminal" }).catch(() => {});
    });

    term.onResize(({ rows, cols }) => {
      const sid = terminalStore.sessionId(props.workspace, props.tabId);
      if (sid == null) return;
      void send({ type: "resize_session", session_id: sid, rows, cols }).catch(() => {});
    });

    const onWinResize = () => fit?.fit();
    window.addEventListener("resize", onWinResize);
    onCleanup(() => window.removeEventListener("resize", onWinResize));
  });

  onCleanup(() => term?.dispose());

  // Rewrite the screen whenever this tab's snapshot changes (full redraw).
  createEffect(() => {
    const screen = terminalStore.screen(props.workspace, props.tabId);
    if (!term || screen === lastScreen) return;
    lastScreen = screen;
    term.reset();
    term.write(screen);
  });

  return <div class="ws-terminal" ref={host} />;
}
