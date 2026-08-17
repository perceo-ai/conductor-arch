import { createStore, produce, reconcile } from "solid-js/store";
import type {
  ArchcarMessage,
  ArchcarProjectionItem,
  ChatSnapshot,
  ProviderEventRecord,
  QueuedArchcarInput,
  SessionKind,
} from "@/bridge/protocol";
import { recordUpdate } from "./metrics";

// Keyed chat store. The heart of the "full control of rerenders" design: chat
// data is keyed by thread id, and every mutation writes the NARROWEST path
// possible. A streaming token for thread 7 touches exactly one text node; other
// threads and other slices of thread 7 never re-run.
//
// This mirrors the intent of refresh.rs (WorkspaceChatMessagesChanged /
// ChatMessageAppended / provider-event delta upsert-by-identity) but expressed as
// path-scoped store writes instead of callback fanout.

export type ChatUiPhase =
  | { kind: "ready" }
  | { kind: "creating"; provider: SessionKind }
  | { kind: "starting"; provider: SessionKind }
  | { kind: "draining"; provider: SessionKind }
  | { kind: "failed"; message: string };

export interface ChatSlice {
  messages: ArchcarMessage[];
  pendingMessages: ArchcarMessage[];
  // provider events keyed by identity_key for in-place delta merge
  providerEvents: Record<string, ProviderEventRecord>;
  // projected timeline items (built in core, keyed by id for delta reconcile)
  projection: ArchcarProjectionItem[];
  queue: QueuedArchcarInput[];
  session: { session_id: number; status: string; runtime_state: string; ready: boolean } | null;
  phase: ChatUiPhase;
}

function emptySlice(): ChatSlice {
  return {
    messages: [],
    pendingMessages: [],
    providerEvents: {},
    projection: [],
    queue: [],
    session: null,
    phase: { kind: "ready" },
  };
}

export function timelineItemsForSlice(s: ChatSlice): ArchcarProjectionItem[] {
  const base: ArchcarProjectionItem[] =
    s.projection.length > 0
      ? s.projection
      : s.messages.map(messageToProjectionItem);
  const pending = s.pendingMessages
    .filter((m) => !base.some((item) => item.render_class === "user_chat" && item.body === m.content))
    .map(messageToProjectionItem);
  return [...base, ...pending];
}

function messageToProjectionItem(m: { id: number; role: string; content: string }): ArchcarProjectionItem {
  return {
    id: `msg-${m.id}`,
    sequence: m.id,
    render_class: m.role === "user" ? "user_chat" : m.role === "system" ? "status_card" : "assistant_chat",
    role_label: m.role,
    title: "",
    body: m.content,
    status: m.id < 0 ? "pending" : "complete",
    stream_state: m.id < 0 ? "streaming" : "complete",
  };
}

const [chat, setChat] = createStore<Record<number, ChatSlice>>({});

function ensure(threadId: number) {
  if (!chat[threadId]) setChat(threadId, emptySlice());
}

export const chatStore = {
  /** Reactive read of a thread slice (creates an empty one on first access). */
  slice(threadId: number): ChatSlice {
    ensure(threadId);
    return chat[threadId];
  },

  /** Replace a thread from a full snapshot. Uses reconcile so unchanged rows keep
   *  their identity and do not re-render. */
  applySnapshot(snap: ChatSnapshot) {
    ensure(snap.thread_id);
    const providerEvents: Record<string, ProviderEventRecord> = {};
    for (const ev of snap.provider_events) providerEvents[ev.identity_key] = ev;
    const persistedUserBodies = new Set(
      snap.messages.filter((m) => m.role === "user").map((m) => m.content),
    );
    setChat(
      snap.thread_id,
      reconcile(
        {
          messages: snap.messages,
          pendingMessages: (chat[snap.thread_id]?.pendingMessages ?? []).filter(
            (m) => !persistedUserBodies.has(m.content),
          ),
          providerEvents,
          projection: chat[snap.thread_id]?.projection ?? [],
          queue: snap.queued_inputs,
          session: snap.live_session
            ? {
                session_id: snap.live_session.session_id,
                status: snap.live_session.status,
                runtime_state: snap.live_session.runtime_state,
                ready: snap.live_session.ready,
              }
            : null,
          phase: chat[snap.thread_id]?.phase ?? { kind: "ready" },
        },
        { key: "id", merge: false },
      ),
    );
    recordUpdate(`chat.snapshot.${snap.thread_id}`);
  },

  /** Reconcile just the message list (keyed by id → only new/changed rows render). */
  setMessages(threadId: number, messages: ArchcarMessage[]) {
    ensure(threadId);
    setChat(threadId, "messages", reconcile(messages, { key: "id", merge: true }));
    recordUpdate(`chat.messages.${threadId}`);
  },

  /** Replace the projected timeline (keyed by id → only changed items render). */
  setProjection(threadId: number, items: ArchcarProjectionItem[]) {
    ensure(threadId);
    setChat(threadId, "projection", reconcile(items, { key: "id", merge: true }));
    recordUpdate(`chat.projection.${threadId}`);
  },

  /** Merge one provider-event delta in place by identity_key. */
  mergeProviderEvent(threadId: number, ev: ProviderEventRecord) {
    ensure(threadId);
    setChat(threadId, "providerEvents", ev.identity_key, ev);
    recordUpdate(`chat.providerEvent.${threadId}`);
  },

  setQueue(threadId: number, queue: QueuedArchcarInput[]) {
    ensure(threadId);
    setChat(threadId, "queue", reconcile(queue, { key: "id", merge: true }));
    recordUpdate(`chat.queue.${threadId}`);
  },

  setSession(threadId: number, session: ChatSlice["session"]) {
    ensure(threadId);
    setChat(threadId, "session", session);
    recordUpdate(`chat.session.${threadId}`);
  },

  setPhase(threadId: number, phase: ChatUiPhase) {
    ensure(threadId);
    setChat(threadId, "phase", phase);
    recordUpdate(`chat.phase.${threadId}`);
  },

  /** A session process exited — clear it from whichever thread owned it so the
   *  running/busy indicators don't get stuck on. */
  markSessionExited(sessionId: number) {
    for (const key of Object.keys(chat)) {
      const threadId = Number(key);
      if (chat[threadId]?.session?.session_id === sessionId) {
        setChat(threadId, "session", null);
        recordUpdate(`chat.sessionExited.${threadId}`);
      }
    }
  },

  /** Local optimistic append (before the durable event arrives). */
  optimisticAppend(threadId: number, message: ArchcarMessage) {
    ensure(threadId);
    setChat(
      threadId,
      "pendingMessages",
      produce((list) => {
        list.push(message);
      }),
    );
    recordUpdate(`chat.optimisticAppend.${threadId}`);
  },

  removeOptimistic(threadId: number, messageId: number) {
    ensure(threadId);
    setChat(
      threadId,
      "pendingMessages",
      produce((list) => {
        const index = list.findIndex((m) => m.id === messageId);
        if (index >= 0) list.splice(index, 1);
      }),
    );
    recordUpdate(`chat.optimisticRemove.${threadId}`);
  },
};
