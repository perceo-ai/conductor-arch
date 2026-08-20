import { createStore } from "solid-js/store";
import { recordUpdate } from "./metrics";
import { togglePick, type NewChatContextPick } from "@/lib/newChatContext";

// Context picked on a chat's empty screen (past transcripts, plans), keyed by
// thread. The picker and the composer are siblings in the chat surface, so the
// selection lives here rather than in either one. Picks are consumed by the
// first send and cleared.

interface NewChatContextState {
  byThread: Record<number, NewChatContextPick[]>;
}

const [state, setState] = createStore<NewChatContextState>({ byThread: {} });

export const newChatContextStore = {
  state,

  picks(threadId: number): NewChatContextPick[] {
    return state.byThread[threadId] ?? [];
  },

  selected(threadId: number, key: string): boolean {
    return this.picks(threadId).some((pick) => pick.key === key);
  },

  toggle(threadId: number, pick: NewChatContextPick) {
    setState("byThread", threadId, togglePick(this.picks(threadId), pick));
    recordUpdate(`newChatContext.toggle.${threadId}`);
  },

  remove(threadId: number, key: string) {
    setState(
      "byThread",
      threadId,
      this.picks(threadId).filter((pick) => pick.key !== key),
    );
    recordUpdate(`newChatContext.remove.${threadId}`);
  },

  set(threadId: number, picks: NewChatContextPick[]) {
    setState("byThread", threadId, picks);
    recordUpdate(`newChatContext.set.${threadId}`);
  },

  clear(threadId: number) {
    setState("byThread", threadId, []);
    recordUpdate(`newChatContext.clear.${threadId}`);
  },
};
