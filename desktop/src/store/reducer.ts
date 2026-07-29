import type { ArchcarEvent, ChatSnapshot } from "@/bridge/protocol";
import { send } from "@/bridge/client";
import { chatStore } from "./chat";

// Event → targeted store mutation. This is the readable equivalent of
// refresh.rs::refresh_event fanout: instead of a switch that fires callback
// slots, we mutate the narrowest store path. Only the DOM bound to that path
// re-renders.
//
// Note: archcar events are notifications, not payloads. For message/provider-event
// changes we pull the authoritative snapshot (get_chat_snapshot) and reconcile —
// reconcile(key:"id") means unchanged rows keep identity and don't re-render.

let inflightSnapshot = new Map<number, boolean>();

async function refreshThreadSnapshot(threadId: number) {
  if (inflightSnapshot.get(threadId)) return;
  inflightSnapshot.set(threadId, true);
  try {
    const [snap, proj] = await Promise.all([
      send({ type: "get_chat_snapshot", thread_id: threadId }),
      send({ type: "get_chat_projection", thread_id: threadId }),
    ]);
    if (snap.type === "chat_snapshot") {
      chatStore.applySnapshot((snap as { snapshot: ChatSnapshot }).snapshot);
    }
    if (proj.type === "chat_projection") {
      chatStore.setProjection(threadId, proj.items);
    }
  } catch {
    // page owns its own error surface; ignore transient failures
  } finally {
    inflightSnapshot.set(threadId, false);
  }
}

/** Force a fresh snapshot+projection pull (used when a chat tab is opened). */
export function loadThread(threadId: number): void {
  void refreshThreadSnapshot(threadId);
}

export function applyEvent(event: ArchcarEvent) {
  switch (event.type) {
    case "session_messages_updated":
      void refreshThreadSnapshot((event as { thread_id: number }).thread_id);
      break;

    case "chat_queue_updated":
      void refreshThreadSnapshot((event as { thread_id: number }).thread_id);
      break;

    case "session_started": {
      const e = event as { thread_id: number; session_id: number };
      chatStore.setSession(e.thread_id, {
        session_id: e.session_id,
        status: "starting",
        runtime_state: "starting",
        ready: false,
      });
      break;
    }

    case "session_ready": {
      const e = event as { thread_id: number; session_id: number };
      chatStore.setPhase(e.thread_id, { kind: "ready" });
      chatStore.setSession(e.thread_id, {
        session_id: e.session_id,
        status: "ready",
        runtime_state: "idle",
        ready: true,
      });
      break;
    }

    case "turn_completed": {
      const e = event as { thread_id: number };
      void refreshThreadSnapshot(e.thread_id);
      break;
    }

    case "session_error": {
      const e = event as { thread_id?: number; message: string };
      if (e.thread_id != null) chatStore.setPhase(e.thread_id, { kind: "failed", message: e.message });
      break;
    }

    default:
      // session_screen_updated, session_exited, etc. handled by the surfaces that
      // care (e.g. terminal) once those pages exist.
      break;
  }
}
