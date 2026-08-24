import { createEffect, onCleanup, onMount } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { send } from "@/bridge/client";
import { terminalStore } from "@/store";
import { createTerminalInputQueue } from "@/lib/terminalInput";

// A single terminal tab — port of terminal.rs. The shell session (archcar
// SpawnSession kind=shell) owns the PTY in core; this renders its screen via
// xterm.js and forwards keystrokes with SendInput raw_terminal. The session is
// spawned by the dock and correlated to this tab in the store; here we just
// render the tab's screen and forward io once a session id exists.

/**
 * Why the sizing here is more careful than a single `fit()` call:
 *
 * A PTY does not reflow. The program on the far end wraps its own output to
 * whatever column count it was told, and that text is already hard-wrapped by
 * the time it reaches us. So the terminal only looks right if the PTY's width
 * tracks the panel's width — and this panel is resized constantly by the dock
 * splitter and the right-panel splitter, neither of which fires a window
 * resize. Fitting on `window.resize` alone meant the PTY usually sat at its
 * default 80 columns while the panel was some other width, which is what makes
 * output look wrapped in the wrong places and never re-wrap when you drag.
 */
export default function TerminalPanel(props: { workspace: string; tabId: string }) {
  let host!: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let lastScreen = "";
  let pendingFit = 0;

  // One writer for this terminal's PTY. Resolves the session id per flush
  // rather than at construction, because the dock spawns the session
  // asynchronously and it may not exist for the first keystrokes.
  const inputQueue = createTerminalInputQueue(async (data) => {
    const sid = terminalStore.sessionId(props.workspace, props.tabId);
    if (sid == null) return;
    await send({ type: "send_input", session_id: sid, input: data, kind: "raw_terminal" });
  });

  /** Fit on the next frame, coalescing bursts from a drag into one measure. */
  function scheduleFit() {
    if (pendingFit) return;
    pendingFit = requestAnimationFrame(() => {
      pendingFit = 0;
      // A hidden or not-yet-laid-out panel measures as 0x0; fitting against
      // that throws inside the addon's dimension maths, and the resulting
      // cols/rows would be meaningless anyway.
      if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit?.fit();
      } catch {
        // Addon throws if the renderer is mid-teardown. The next resize refits.
      }
    });
  }

  onMount(() => {
    term = new Terminal({
      // xterm measures character cells against this exact string. A `var(...)`
      // reference resolves for the DOM renderer but not in canvas measurement,
      // and a mismatch there puts every glyph fractionally off its cell — so
      // resolve the token to a concrete font stack up front.
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--ui-font-mono").trim() ||
        "ui-monospace, monospace",
      fontSize: 13,
      theme: { background: "#151515", foreground: "#d4d4d4" },
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // After open, not during: the rows element has no measurable size until the
    // terminal has attached and the browser has laid it out once.
    scheduleFit();

    // Through the queue, never directly: a keystroke per RPC with none of them
    // awaited let the requests race, and typing faster than the round-trip
    // arrived transposed ("printf" landing as "pirnft").
    term.onData((data) => inputQueue.write(data));

    term.onResize(({ rows, cols }) => {
      const sid = terminalStore.sessionId(props.workspace, props.tabId);
      if (sid == null) return;
      void send({ type: "resize_session", session_id: sid, rows, cols }).catch(() => {});
    });

    // The splitters resize this element without resizing the window, so the
    // element itself is what has to be observed.
    const observer = new ResizeObserver(() => scheduleFit());
    observer.observe(host);

    const onWinResize = () => scheduleFit();
    window.addEventListener("resize", onWinResize);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", onWinResize);
      if (pendingFit) cancelAnimationFrame(pendingFit);
    });
  });

  onCleanup(() => {
    inputQueue.dispose();
    term?.dispose();
  });

  // The dock spawns the shell session asynchronously, so the first fit almost
  // always runs before there is a session to tell. `onResize` drops that one
  // (no id yet) and then never fires again, because the measured size has not
  // changed since — leaving the PTY on its default 80 columns for the life of
  // the tab unless the user happened to drag a splitter. Push the dimensions
  // once the id arrives.
  createEffect(() => {
    const sid = terminalStore.sessionId(props.workspace, props.tabId);
    if (sid == null || !term) return;
    void send({
      type: "resize_session",
      session_id: sid,
      rows: term.rows,
      cols: term.cols,
    }).catch(() => {});
  });

  // The daemon sends a full screen snapshot each time. Rewriting all of it
  // resets the viewport to the top and discards scrollback, so a terminal
  // printing steadily was unusable — it jumped on every chunk. Appends are the
  // overwhelmingly common case and can be written as a delta, which leaves the
  // cursor, the scroll position and the scrollback intact.
  createEffect(() => {
    const screen = terminalStore.screen(props.workspace, props.tabId);
    if (!term || screen === lastScreen) return;
    if (lastScreen && screen.startsWith(lastScreen)) {
      term.write(screen.slice(lastScreen.length));
    } else {
      term.reset();
      term.write(screen);
    }
    lastScreen = screen;
  });

  return <div class="ws-terminal" ref={host} />;
}
