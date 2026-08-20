import { createStore } from "solid-js/store";
import { recordUpdate } from "./metrics";
import type { ProviderInteractionRecord } from "@/bridge/protocol";

// Pending agent interactions (permission / question / plan approval), keyed by
// thread. Only one is shown at a time per thread; a new request replaces the
// prior pending one for that thread, and a resolved event clears it.

interface InteractionsState {
  byThread: Record<number, ProviderInteractionRecord>;
}

const [state, setState] = createStore<InteractionsState>({ byThread: {} });

export const interactionsStore = {
  state,

  pending(threadId: number): ProviderInteractionRecord | undefined {
    return state.byThread[threadId];
  },

  /** Seed from a fetch — the window may have missed the original event. */
  setPending(threadId: number, pending: ProviderInteractionRecord[]) {
    const next = pending.find((rec) => rec.status === "pending");
    if (next) setState("byThread", threadId, next);
    else if (state.byThread[threadId]) setState("byThread", threadId, undefined!);
    recordUpdate(`interactions.setPending.${threadId}`);
  },

  request(rec: ProviderInteractionRecord) {
    setState("byThread", rec.thread_id, rec);
    recordUpdate(`interactions.request.${rec.thread_id}`);
  },

  resolve(rec: ProviderInteractionRecord) {
    if (state.byThread[rec.thread_id]?.id === rec.id) {
      setState("byThread", rec.thread_id, undefined!);
      recordUpdate(`interactions.resolve.${rec.thread_id}`);
    }
  },
};
