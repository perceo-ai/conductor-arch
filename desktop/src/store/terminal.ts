import { createStore } from "solid-js/store";
import { recordUpdate } from "./metrics";

// Terminal state keyed by workspace. The shell session_id is discovered from the
// session_started event (spawn is async), and the screen snapshot is refreshed
// on each session_screen_updated. A reverse session_id -> workspace map routes
// screen updates. The Rust archcar session owns the PTY; this only mirrors its
// rendered screen and forwards keystrokes.

interface TermSlice {
  sessionId: number | null;
  screen: string;
}

interface TermState {
  byWorkspace: Record<string, TermSlice>;
}

const [state, setState] = createStore<TermState>({ byWorkspace: {} });
const sessionToWorkspace = new Map<number, string>();

function ensure(ws: string) {
  if (!state.byWorkspace[ws]) setState("byWorkspace", ws, { sessionId: null, screen: "" });
}

export const terminalStore = {
  slice(ws: string): TermSlice {
    ensure(ws);
    return state.byWorkspace[ws];
  },

  sessionId(ws: string): number | null {
    return state.byWorkspace[ws]?.sessionId ?? null;
  },

  setSession(ws: string, sessionId: number) {
    ensure(ws);
    setState("byWorkspace", ws, "sessionId", sessionId);
    sessionToWorkspace.set(sessionId, ws);
    recordUpdate(`terminal.session.${ws}`);
  },

  /** Route a screen snapshot to its workspace slice (by session id). */
  setScreen(sessionId: number, screen: string) {
    const ws = sessionToWorkspace.get(sessionId);
    if (!ws) return;
    setState("byWorkspace", ws, "screen", screen);
    recordUpdate(`terminal.screen.${ws}`);
  },
};
