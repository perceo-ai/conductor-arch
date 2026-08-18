import type {
  ArchcarEvent,
  BackgroundTask,
  ChatSnapshot,
  ProviderInteractionRecord,
} from "@/bridge/protocol";
import { send } from "@/bridge/client";
import { chatStore } from "./chat";
import { terminalStore } from "./terminal";
import { interactionsStore } from "./interactions";
import { workspacesStore } from "./workspaces";
import { intelStore } from "./intel";

async function refreshTerminalScreen(sessionId: number) {
  try {
    const res = await send({ type: "get_session_screen", session_id: sessionId });
    if (res.type === "session_screen") terminalStore.setScreen(sessionId, res.screen);
  } catch {
    // transient; the next update event retries
  }
}

// Event → targeted store mutation. This is the readable equivalent of
// refresh.rs::refresh_event fanout: instead of a switch that fires callback
// slots, we mutate the narrowest store path. Only the DOM bound to that path
// re-renders.
//
// Note: archcar events are notifications, not payloads. For message/provider-event
// changes we pull the authoritative snapshot (get_chat_snapshot) and reconcile —
// reconcile(key:"id") means unchanged rows keep identity and don't re-render.

const inflightSnapshot = new Set<number>();
const pendingSnapshot = new Set<number>();

async function refreshThreadSnapshot(threadId: number) {
  // Coalesce: if a pull is already running for this thread, mark it for one
  // follow-up so the final state (messages/queue/projection) isn't lost when a
  // notification arrives mid-flight — but never stack more than one.
  if (inflightSnapshot.has(threadId)) {
    pendingSnapshot.add(threadId);
    return;
  }
  inflightSnapshot.add(threadId);
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
    inflightSnapshot.delete(threadId);
    if (pendingSnapshot.delete(threadId)) {
      void refreshThreadSnapshot(threadId);
    }
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
      const e = event as {
        thread_id: number;
        session_id: number;
        workspace: string;
        kind: string;
      };
      // Shell sessions back the Terminal tab; correlate the async spawn to its
      // workspace and pull the first screen.
      if (e.kind === "shell") {
        terminalStore.attachSession(e.workspace, e.session_id);
        void refreshTerminalScreen(e.session_id);
      } else {
        chatStore.setSession(e.thread_id, {
          session_id: e.session_id,
          status: "starting",
          runtime_state: "starting",
          ready: false,
        });
        // A fresh session starting clears any stale "failed" phase from a prior
        // turn so the composer doesn't keep showing an error.
        if (chatStore.slice(e.thread_id).phase.kind === "failed") {
          chatStore.setPhase(e.thread_id, { kind: "ready" });
        }
      }
      break;
    }

    case "session_exited": {
      // Clear the exited session so running/busy spinners don't stick on.
      chatStore.markSessionExited((event as { session_id: number }).session_id);
      break;
    }

    case "provider_interaction_requested": {
      interactionsStore.request(
        (event as { interaction: ProviderInteractionRecord }).interaction,
      );
      break;
    }

    case "provider_interaction_resolved": {
      interactionsStore.resolve(
        (event as { interaction: ProviderInteractionRecord }).interaction,
      );
      break;
    }

    case "session_screen_updated": {
      void refreshTerminalScreen((event as { session_id: number }).session_id);
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

    case "background_task_updated": {
      // Notify when a background task settles — the user may be away; that is
      // the point of background work. Non-terminal advances stay silent.
      const task = (event as { task: BackgroundTask }).task;
      if (task.status === "ready" || task.status === "failed") {
        const title =
          task.status === "ready" ? "Background task ready" : "Background task failed";
        const body = `#${task.id} ${task.title}${task.workspace_name ? ` (${task.workspace_name})` : ""}: ${task.detail || task.error || task.status}`;
        try {
          if (typeof Notification !== "undefined" && Notification.permission !== "denied") {
            new Notification(title, { body });
          }
        } catch {
          // Notifications are best-effort; the dashboard strip still updates.
        }
      }
      break;
    }

    case "summary_updated": {
      intelStore.refreshWorkspaceIntel((event as { workspace: string }).workspace);
      break;
    }

    case "task_updated": {
      // Task counts feed the sidebar rows and the Summary tab badge.
      intelStore.refreshWorkspaceIntel((event as { workspace: string }).workspace);
      void workspacesStore.refresh().catch(() => {});
      break;
    }

    default:
      // session_screen_updated, session_exited, etc. handled by the surfaces that
      // care (e.g. terminal) once those pages exist.
      break;
  }
}
