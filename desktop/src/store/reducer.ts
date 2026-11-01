import type {
  ArchcarEvent,
  ChatSnapshot,
  ProviderInteractionRecord,
} from "@/bridge/protocol";
import { notify, send } from "@/bridge/client";
import { notificationForArchcarEvent } from "@/lib/eventNotifications";
import { createRefreshCoalescer } from "@/lib/refreshCoalescer";
import { chatStore } from "./chat";
import { terminalStore } from "./terminal";
import { interactionsStore } from "./interactions";
import { nav } from "./nav";
import { workspacesStore } from "./workspaces";
import { threadsStore } from "./threads";
import { intelStore } from "./intel";
import { daemonChangedSince, daemonEpoch } from "./daemonEpoch";
import { observeChatGeneration } from "./turnSound";

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
  // Whether this pull may decide the chat finished: both the snapshot (main
  // agent) and the projection (subagents) must have come back, from the daemon
  // still connected. A failed half leaves the other half stale, and a stale
  // projection is exactly how a running subagent gets missed.
  const epoch = daemonEpoch();
  let fresh = false;
  try {
    // Interactions and plan state are pulled, not just listened for: an ask
    // raised before this window opened (or before this chat was selected) has
    // no event left to replay, and an unanswered question the user cannot see
    // is a hung agent.
    const [snap, proj, interactions, plan] = await Promise.all([
      // The timeline comes from the projection; the snapshot is only read for
      // messages, the queue and the live session. Provider events are the bulk
      // of it and nothing here consumes them.
      send({ type: "get_chat_snapshot", thread_id: threadId, include_provider_events: false }),
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
    fresh = snap.type === "chat_snapshot" && proj.type === "chat_projection";
  } catch {
    // page owns its own error surface; ignore transient failures
  } finally {
    inflightSnapshot.delete(threadId);
    const followUp = pendingSnapshot.delete(threadId);
    if (fresh && !daemonChangedSince(epoch)) {
      // Busy is recorded from every pull, so a turn whose pulls always have a
      // follow-up queued still has a busy baseline. Finished is only judged on
      // a settled pull: one with a follow-up queued is already stale.
      observeChatGeneration(threadId, { canFinish: !followUp });
    }
    if (followUp) void refreshThreadSnapshot(threadId);
  }
}

// A streaming turn emits `session_messages_updated` once per provider event —
// per token — and each one used to cost a full snapshot + projection pull, so
// the renderer spent an active turn re-reading the whole thread and got slower
// the longer the chat ran. Ten pulls a second is still far past the rate a
// human reads at, and turn boundaries flush immediately.
const CHAT_REFRESH_INTERVAL_MS = 100;

const chatRefresh = createRefreshCoalescer<number>(
  (threadId) => void refreshThreadSnapshot(threadId),
  { intervalMs: CHAT_REFRESH_INTERVAL_MS },
);

/** Force a fresh snapshot+projection pull (used when a chat tab is opened). */
export function loadThread(threadId: number): void {
  chatRefresh.flush(threadId);
}

/// Which workspace owns the event's chat, so the banner can name it rather
/// than "Thread 42". Undefined when the thread list has not loaded it.
function workspaceForThread(event: ArchcarEvent): string | undefined {
  const threadId = (event as { thread_id?: number }).thread_id;
  if (threadId == null) return undefined;
  return Object.entries(threadsStore.state.byWorkspace).find(([, threads]) =>
    threads.some((thread) => thread.id === threadId),
  )?.[0];
}

export function applyEvent(event: ArchcarEvent) {
  // OS banners are for the window you are not looking at. While Archductor is
  // focused the chat itself shows the turn ending / ask arriving, and a native
  // notification on top of it is pure noise.
  const notification = nav.windowFocused()
    ? null
    : notificationForArchcarEvent(event, workspaceForThread(event));
  if (notification) void notify(notification);

  switch (event.type) {
    case "session_messages_updated":
      chatRefresh.request((event as { thread_id: number }).thread_id);
      break;

    case "chat_plan_updated": {
      const e = event as { thread_id: number; plan_mode: boolean; plan_path?: string };
      chatStore.setPlanMode(e.thread_id, e.plan_mode);
      chatStore.setPlanPath(e.thread_id, e.plan_path ?? null);
      break;
    }

    case "chat_queue_updated":
      chatRefresh.request((event as { thread_id: number }).thread_id);
      void refreshThreadWorkspace((event as { thread_id: number }).thread_id);
      break;

    case "session_started": {
      const e = event as {
        thread_id: number;
        session_id: number;
        workspace: string;
        kind: string;
        replayed?: boolean;
        ready?: boolean;
        runtime_state?: string;
      };
      // Shell sessions back the Terminal tab; correlate the async spawn to its
      // workspace and pull the first screen.
      if (e.kind === "shell") {
        terminalStore.attachSession(e.workspace, e.session_id);
        void refreshTerminalScreen(e.session_id);
      } else {
        // A replay on connect carries the session's real readiness and
        // runtime state (an agent parked on a question is not ready but
        // `waiting_for_input`, which is not work); a genuine start is never
        // ready yet and carries neither.
        chatStore.setSession(e.thread_id, {
          session_id: e.session_id,
          status: e.ready ? "ready" : "starting",
          runtime_state: e.runtime_state ?? (e.ready ? "idle" : "starting"),
          ready: e.ready ?? false,
        });
        // A fresh session starting clears any stale "failed" phase from a prior
        // turn so the composer doesn't keep showing an error.
        if (chatStore.slice(e.thread_id).phase.kind === "failed") {
          chatStore.setPhase(e.thread_id, { kind: "ready" });
        }
        // Record busy now rather than waiting for a pull: a short turn can
        // start and finish inside one refresh interval, and a detector that
        // never saw it busy cannot hear it finish. This only ever records
        // busy (canFinish: false). Deciding a chat finished needs a settled
        // snapshot-and-projection pull: on a reconnect the stored subagent
        // cards are stale, and a background agent launched while disconnected
        // would otherwise be missed.
        observeChatGeneration(e.thread_id, { canFinish: false });
      }
      void refreshThreadWorkspace(e.thread_id);
      break;
    }

    case "session_exited": {
      // Clear the exited session so running/busy spinners don't stick on.
      for (const threadId of chatStore.markSessionExited((event as { session_id: number }).session_id)) {
        observeChatGeneration(threadId);
      }
      void refreshWorkspaceInventoryAndChats();
      break;
    }

    case "provider_interaction_requested": {
      const interaction = (event as { interaction: ProviderInteractionRecord }).interaction;
      interactionsStore.request(interaction);
      // An agent parked on a question is waiting on the operator: that is the
      // moment the sound exists for, unless a subagent is still working. The
      // stored projection, or a pull already in flight, may predate a subagent
      // launched just before the ask. Flush rather than request: a request
      // inside the interval only sets a timer, so an in-flight pull would not
      // know it is stale and would judge the chat finished. Flushing marks it
      // for a follow-up, and the settled follow-up decides.
      chatRefresh.flush(interaction.thread_id);
      break;
    }

    case "provider_interaction_resolved": {
      const interaction = (event as { interaction: ProviderInteractionRecord }).interaction;
      interactionsStore.resolve(interaction);
      observeChatGeneration(interaction.thread_id);
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
      // Pull the projection too: whether a subagent outlives this turn is only
      // known from it, and the sound waits on that answer.
      chatRefresh.request(e.thread_id);
      void refreshThreadWorkspace(e.thread_id);
      break;
    }

    case "turn_completed": {
      const e = event as { thread_id: number };
      chatStore.setCompletedTurnAttention(e.thread_id, !nav.chatThreadInView(e.thread_id));
      // The end of a turn is the state the user reads; never sit on it.
      chatRefresh.flush(e.thread_id);
      void refreshThreadWorkspace(e.thread_id);
      break;
    }

    case "session_error": {
      const e = event as { thread_id?: number; message: string };
      if (e.thread_id != null) chatStore.setPhase(e.thread_id, { kind: "failed", message: e.message });
      break;
    }

    case "background_task_updated": {
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
      nav.renameWorkspace(e.old_name, e.new_name);
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
