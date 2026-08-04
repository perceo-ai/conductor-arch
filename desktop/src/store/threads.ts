import { createStore, reconcile } from "solid-js/store";
import { recordUpdate } from "./metrics";
import { send } from "@/bridge/client";
import type { ArchcarChatThread } from "@/bridge/protocol";

// Chat threads keyed by workspace name. Each workspace's chat-tab strip reads
// only its own slice, so loading threads for one workspace never re-renders
// another's tabs.

interface ThreadsState {
  byWorkspace: Record<string, ArchcarChatThread[]>;
}

const [state, setState] = createStore<ThreadsState>({ byWorkspace: {} });

export const threadsStore = {
  state,

  list(workspace: string): ArchcarChatThread[] {
    return state.byWorkspace[workspace] ?? [];
  },

  setThreads(workspace: string, threads: ArchcarChatThread[]) {
    setState("byWorkspace", workspace, reconcile(threads, { key: "id", merge: true }));
    recordUpdate(`threads.${workspace}`);
  },

  async refresh(workspace: string): Promise<ArchcarChatThread[]> {
    const res = await send({ type: "list_chat_threads", workspace });
    if (res.type !== "chat_threads") return [];
    // Closing a thread only marks it status="closed" in the DB; the backend list
    // still returns it, so drop closed threads here or their tab never goes away.
    const open = res.threads.filter((t) => t.status !== "closed");
    this.setThreads(workspace, open);
    return open;
  },
};
