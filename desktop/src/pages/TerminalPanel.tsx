import { createEffect, onCleanup, onMount } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { send } from "@/bridge/client";
import { terminalStore } from "@/store";

// Terminal tab — port of terminal.rs. A shell session (archcar SpawnSession
// kind=shell) owns the PTY in core; this renders its screen via xterm.js and
// forwards keystrokes with SendInput raw_terminal. The screen snapshot is
// refreshed on session_screen_updated (see reducer) and rewritten wholesale —
// core returns the full rendered screen, not a byte delta.

export default function TerminalPanel(props: { workspace: string }) {
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

    // Forward keystrokes to the shell session (raw terminal bytes).
    term.onData((data) => {
      const sid = terminalStore.sessionId(props.workspace);
      if (sid == null) return;
      void send({
        type: "send_input",
        session_id: sid,
        input: data,
        kind: "raw_terminal",
      }).catch(() => {});
    });

    // Report the viewport size to the PTY.
    term.onResize(({ rows, cols }) => {
      const sid = terminalStore.sessionId(props.workspace);
      if (sid == null) return;
      void send({ type: "resize_session", session_id: sid, rows, cols }).catch(() => {});
    });

    const onWinResize = () => fit?.fit();
    window.addEventListener("resize", onWinResize);
    onCleanup(() => window.removeEventListener("resize", onWinResize));

    // Spawn (or re-attach) the shell. session_started fires with the id, which
    // the reducer records; the panel reads it from terminalStore. If a session
    // already exists for this workspace, reuse it (spawn is idempotent-ish: a
    // fresh shell just starts a new session).
    if (terminalStore.sessionId(props.workspace) == null) {
      void send({ type: "spawn_session", workspace: props.workspace, kind: "shell" }).catch(() => {});
    }
  });

  onCleanup(() => term?.dispose());

  // Rewrite the screen whenever the snapshot changes (full-screen redraw).
  createEffect(() => {
    const screen = terminalStore.slice(props.workspace).screen;
    if (!term || screen === lastScreen) return;
    lastScreen = screen;
    term.reset();
    term.write(screen);
  });

  return <div class="ws-terminal" ref={host} />;
}
