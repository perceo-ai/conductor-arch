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
import { nav } from "./nav";
import { workspacesStore } from "./workspaces";
import { threadsStore } from "./threads";
import { intelStore } from "./intel";

async function refreshWorkspaceInventoryAndChats() {
  try {
    await workspacesStore.refresh();
    const activeWorkspaces = workspacesStore.state.order.filter(
      (name) => workspacesStore.row(name)?.status !== "archived",
    );
    await threadsStore.refreshMany(activeWorkspaces);
  } catch {
    // transient; the next event or focus refresh retries
  }
}

async function refreshThreadWorkspace(threadId: number) {
  const workspace = threadsStore.workspaceForThread(threadId);
  if (!workspace) {
    await refreshWorkspaceInventoryAndChats();
    return;
  }
  try {
    await Promise.all([workspacesStore.refresh(), threadsStore.refresh(workspace)]);
  } catch {
    // transient; the next event or focus refresh retries
  }
}

async function refreshThreadWorkspaceByName(workspace: string) {
  try {
    await Promise.all([workspacesStore.refresh(), threadsStore.refresh(workspace)]);
  } catch {
    // transient; the next event or focus refresh retries
  }
}

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
    // Interactions and plan state are pulled, not just listened for: an ask
    // raised before this window opened (or before this chat was selected) has
    // no event left to replay, and an unanswered question the user cannot see
    // is a hung agent.
    const [snap, proj, interactions, plan] = await Promise.all([
      send({ type: "get_chat_snapshot", thread_id: threadId }),
      send({ type: "get_chat_projection", thread_id: threadId }),
      send({ type: "list_provider_interactions", thread_id: threadId, pending_only: true }),
      send({ type: "get_chat_plan", thread_id: threadId }),
    ]);
    if (snap.type === "chat_snapshot") {
      chatStore.applySnapshot((snap as { snapshot: ChatSnapshot }).snapshot);
    }
    if (proj.type === "chat_projection") {
      chatStore.setProjection(threadId, proj.items);
    }
    if (interactions.type === "provider_interactions") {
      interactionsStore.setPending(threadId, interactions.interactions);
    }
    if (plan.type === "chat_plan") {
      chatStore.setPlanMode(threadId, plan.plan_mode);
      chatStore.setPlanPath(threadId, plan.plan_path ?? null);
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

    case "chat_plan_updated": {
      const e = event as { thread_id: number; plan_mode: boolean; plan_path?: string };
      chatStore.setPlanMode(e.thread_id, e.plan_mode);
      chatStore.setPlanPath(e.thread_id, e.plan_path ?? null);
      break;
    }

    case "chat_queue_updated":
      void refreshThreadSnapshot((event as { thread_id: number }).thread_id);
      void refreshThreadWorkspace((event as { thread_id: number }).thread_id);
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
      void refreshThreadWorkspace(e.thread_id);
      break;
    }

    case "session_exited": {
      // Clear the exited session so running/busy spinners don't stick on.
      chatStore.markSessionExited((event as { session_id: number }).session_id);
      void refreshWorkspaceInventoryAndChats();
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
      void refreshThreadWorkspace(e.thread_id);
      break;
    }

    case "turn_completed": {
      const e = event as { thread_id: number };
      chatStore.setCompletedTurnAttention(e.thread_id, nav.selectedChatThread() !== e.thread_id);
      void refreshThreadSnapshot(e.thread_id);
      void refreshThreadWorkspace(e.thread_id);
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
      void refreshWorkspaceInventoryAndChats();
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

    case "workspace_renamed": {
      // The naming pipeline renamed this workspace server-side (first-message
      // agent metadata, or a pull request title). Everything here keys off the
      // name, so re-point selection before reloading or the open workspace goes
      // blank.
      const e = event as { old_name: string; new_name: string };
      if (nav.selectedWorkspace() === e.old_name) nav.selectWorkspace(e.new_name);
      void refreshWorkspaceInventoryAndChats();
      break;
    }

    case "chat_thread_renamed": {
      // Retitled from agent metadata; the tab strip reads the thread list.
      void refreshThreadWorkspace((event as { thread_id: number }).thread_id);
      break;
    }

    case "inventory_changed": {
      const e = event as { scope: string; workspace?: string };
      if (e.scope === "repositories") {
        void refreshWorkspaceInventoryAndChats();
      } else if (e.workspace) {
        void refreshThreadWorkspaceByName(e.workspace);
      } else {
        void refreshWorkspaceInventoryAndChats();
      }
      break;
    }

    default:
      // session_screen_updated, session_exited, etc. handled by the surfaces that
      // care (e.g. terminal) once those pages exist.
      break;
  }
}
