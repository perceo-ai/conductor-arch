import { createStore } from "solid-js/store";
import { recordUpdate } from "./metrics";

// Terminal state keyed by workspace, supporting multiple terminal tabs per
// workspace (parity with the GTK run console). Each tab owns a PTY-backed shell
// session in core. Spawn is async and session_started only reports the
// workspace + session_id (not which tab asked), so we correlate: addTerminal
// pushes a client-side tab id onto a per-workspace `pending` queue, and the next
// shell session_started for that workspace claims the oldest pending tab.

interface TermTab {
  id: string; // client-generated stable id
  sessionId: number | null;
  screen: string;
}

interface WsTerms {
  terminals: TermTab[];
  activeId: string | null;
  pending: string[]; // tab ids awaiting a session_started to claim
  seq: number; // monotonic id counter
}

interface TermState {
  byWorkspace: Record<string, WsTerms>;
}

const [state, setState] = createStore<TermState>({ byWorkspace: {} });
// session_id -> { ws, tabId } so screen updates route to the right tab.
const sessionToTab = new Map<number, { ws: string; tabId: string }>();

function ensure(ws: string) {
  if (!state.byWorkspace[ws])
    setState("byWorkspace", ws, { terminals: [], activeId: null, pending: [], seq: 0 });
}

function tabIndex(ws: string, tabId: string): number {
  return state.byWorkspace[ws]?.terminals.findIndex((t) => t.id === tabId) ?? -1;
}

export const terminalStore = {
  slice(ws: string): WsTerms {
    ensure(ws);
    return state.byWorkspace[ws];
  },

  terminals(ws: string): TermTab[] {
    ensure(ws);
    return state.byWorkspace[ws].terminals;
  },

  activeId(ws: string): string | null {
    return state.byWorkspace[ws]?.activeId ?? null;
  },

  setActive(ws: string, tabId: string) {
    ensure(ws);
    setState("byWorkspace", ws, "activeId", tabId);
  },

  sessionId(ws: string, tabId: string): number | null {
    const i = tabIndex(ws, tabId);
    return i < 0 ? null : state.byWorkspace[ws].terminals[i].sessionId;
  },

  /** Create a new terminal tab, mark it pending a session, and make it active. */
  addTerminal(ws: string): string {
    ensure(ws);
    const seq = state.byWorkspace[ws].seq + 1;
    const id = `term-${seq}`;
    setState("byWorkspace", ws, "seq", seq);
    setState("byWorkspace", ws, "terminals", (t) => [...t, { id, sessionId: null, screen: "" }]);
    setState("byWorkspace", ws, "pending", (p) => [...p, id]);
    setState("byWorkspace", ws, "activeId", id);
    recordUpdate(`terminal.add.${ws}`);
    return id;
  },

  /** Remove a terminal tab (best-effort; the core session is killed by caller). */
  removeTerminal(ws: string, tabId: string) {
    const i = tabIndex(ws, tabId);
    if (i < 0) return;
    const sid = state.byWorkspace[ws].terminals[i].sessionId;
    if (sid != null) sessionToTab.delete(sid);
    setState("byWorkspace", ws, "terminals", (t) => t.filter((x) => x.id !== tabId));
    setState("byWorkspace", ws, "pending", (p) => p.filter((x) => x !== tabId));
    if (state.byWorkspace[ws].activeId === tabId) {
      const rest = state.byWorkspace[ws].terminals;
      setState("byWorkspace", ws, "activeId", rest.length ? rest[rest.length - 1].id : null);
    }
    recordUpdate(`terminal.remove.${ws}`);
  },

  /** Claim the oldest pending tab for this workspace with a fresh session id. */
  attachSession(ws: string, sessionId: number) {
    ensure(ws);
    const pending = state.byWorkspace[ws].pending;
    const tabId = pending[0];
    if (!tabId) return; // no tab waiting (stale spawn) — ignore
    setState("byWorkspace", ws, "pending", (p) => p.slice(1));
    const i = tabIndex(ws, tabId);
    if (i < 0) return;
    setState("byWorkspace", ws, "terminals", i, "sessionId", sessionId);
    sessionToTab.set(sessionId, { ws, tabId });
    recordUpdate(`terminal.session.${ws}`);
  },

  /** Route a screen snapshot to its tab (by session id). */
  setScreen(sessionId: number, screen: string) {
    const loc = sessionToTab.get(sessionId);
    if (!loc) return;
    const i = tabIndex(loc.ws, loc.tabId);
    if (i < 0) return;
    setState("byWorkspace", loc.ws, "terminals", i, "screen", screen);
    recordUpdate(`terminal.screen.${loc.ws}`);
  },

  screen(ws: string, tabId: string): string {
    const i = tabIndex(ws, tabId);
    return i < 0 ? "" : state.byWorkspace[ws].terminals[i].screen;
  },
};
