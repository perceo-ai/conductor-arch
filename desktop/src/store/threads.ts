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
    this.setThreads(workspace, res.threads);
    return res.threads;
  },
};
