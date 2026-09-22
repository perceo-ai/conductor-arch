import { createStore, produce } from "solid-js/store";
import { recordUpdate } from "./metrics";
import type { ComposerNode } from "@/lib/composerDocument";

// Unsent composer text, keyed by chat thread.
//
// The composer used to hold its own document in a local signal, which made the
// draft a property of the mounted component rather than of the chat: leaving
// the chat surface (opening a file or a commit, switching panels) destroyed it,
// and switching chats did not — the same component kept the same signal, so a
// half-typed message followed the reader into somebody else's conversation.
// A draft belongs to its thread, so it lives here.

interface ComposerDraftsState {
  byThread: Record<number, ComposerNode[]>;
}

const [state, setState] = createStore<ComposerDraftsState>({ byThread: {} });

const EMPTY: ComposerNode[] = [];

export const composerDraftsStore = {
  state,

  nodes(threadId: number): ComposerNode[] {
    return state.byThread[threadId] ?? EMPTY;
  },

  /** Empty drafts are dropped rather than stored, so the map stays the set of
   *  chats that actually have something waiting. */
  set(threadId: number, nodes: ComposerNode[]) {
    if (nodes.length === 0) {
      this.clear(threadId);
      return;
    }
    setState("byThread", threadId, nodes);
    recordUpdate(`composerDrafts.set.${threadId}`);
  },

  clear(threadId: number) {
    if (!(threadId in state.byThread)) return;
    setState(
      "byThread",
      produce((byThread: Record<number, ComposerNode[]>) => {
        delete byThread[threadId];
      }),
    );
    recordUpdate(`composerDrafts.clear.${threadId}`);
  },
};
