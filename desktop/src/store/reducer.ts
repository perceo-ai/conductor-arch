import type {
  ArchcarEvent,
  ChatSnapshot,
  ProviderInteractionRecord,
} from "@/bridge/protocol";
import { notify, send } from "@/bridge/client";
import { notificationForArchcarEvent, type NotificationContext } from "@/lib/eventNotifications";
import { createRefreshCoalescer } from "@/lib/refreshCoalescer";
import { chatStore } from "./chat";
import { terminalStore } from "./terminal";
import { interactionsStore } from "./interactions";
import { nav } from "./nav";
import { workspacesStore } from "./workspaces";
import { threadsStore } from "./threads";
import { intelStore } from "./intel";
import { attentionStore } from "./attention";
import { daemonChangedSince, daemonEpoch } from "./daemonEpoch";
import { noteTurnCompleted, observeChatGeneration } from "./turnSound";


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
export const CHAT_REFRESH_INTERVAL_MS = 250;

/**
 * How long a burst of lifecycle events is given to finish before the workspace
 * inventory is re-read.
 *
 * `list_workspaces` is the most expensive call the renderer makes: the daemon
 * answers it with roughly six git subprocesses per active workspace, measured
 * at ~450ms each and 5s across ten workspaces
 * (`docs/evidence/2026-11-19-concurrent-chat-perf-baseline.md`). One agent turn
 * emits a spawn, a start, a ready, interactions and a completion, and six
 * different event types used to answer each of those with a full inventory
 * re-read, so a busy minute across ten workspaces kept the daemon permanently
 * spawning git. Trailing-only, matching iOS's `refreshQuietWindow`.
 */
const INVENTORY_REFRESH_INTERVAL_MS = 250;

const chatRefresh = createRefreshCoalescer<number>(
  (threadId) => void refreshThreadSnapshot(threadId),
  { intervalMs: CHAT_REFRESH_INTERVAL_MS },
);

// One coalescer key, because `list_workspaces` is global: one call serves every
// workspace, and it is the expensive half. Chat lists are per workspace and
// cheap (a database read), so which of them to pull is accumulated alongside
// and drained by the same run.
//
// Keying the queue by workspace name was the first attempt and was wrong twice
// over: ten workspaces meant ten full inventory reads, and two independent keys
// gave no ordering between the workspace list and the chat lists that are
// chosen from it — so after a rename the chat lists were pulled for the old
// name.
const INVENTORY_KEY = "\u0000workspaces";

/** Whose chat lists the next inventory run owes. `"all"` wins over any set. */
let owedChatLists: Set<string> | "all" = new Set();

function oweChatList(workspace: string | undefined) {
  if (owedChatLists === "all") return;
  if (workspace == null) {
    owedChatLists = "all";
    return;
  }
  owedChatLists.add(workspace);
}

const refreshQueue = createRefreshCoalescer<string>(
  () => void runInventoryRefresh(),
  { intervalMs: INVENTORY_REFRESH_INTERVAL_MS, leading: false },
);

/**
 * The workspace list first, awaited, then the chat lists owed.
 *
 * The order is load-bearing: the chat lists to pull are read from
 * `workspacesStore.state.order`, so doing them concurrently asks for whatever
 * names the previous inventory had.
 */
async function runInventoryRefresh() {
  const owed = owedChatLists;
  owedChatLists = new Set();
  await workspacesStore.refresh().catch(() => {});
  const workspaces =
    owed === "all"
      ? workspacesStore.state.order.filter(
          (name) => workspacesStore.row(name)?.status !== "archived",
        )
      : [...owed];
  await threadsStore.refreshMany(workspaces);
}

/** Re-read the workspace list and every chat list once the burst settles. */
function requestInventoryRefresh(): void {
  oweChatList(undefined);
  refreshQueue.request(INVENTORY_KEY);
}

/** Re-read the workspace list, plus one workspace's chat list. */
function requestWorkspaceRefresh(workspace: string | undefined): void {
  oweChatList(workspace);
  refreshQueue.request(INVENTORY_KEY);
}

/**
 * Re-read now: the end of a turn is the state the user reads, so it must not
 * wait out an interval.
 *
 * Only the named workspace's chat list is owed when it is known. A turn
 * boundary is the hottest lifecycle event there is, and pulling every
 * workspace's chat list on each one would undo the saving this exists for.
 */
function flushInventoryRefresh(workspace: string | undefined): void {
  oweChatList(workspace);
  refreshQueue.flush(INVENTORY_KEY);
}

/** Force a fresh snapshot+projection pull (used when a chat tab is opened). */
export function loadThread(threadId: number): void {
  chatRefresh.flush(threadId);
}

/// What the thread list knows about the event's chat, so a banner can read
/// "antix · fix the parser / Done in 4m 12s" rather than "Thread 42".
/// Empty when the thread list has not loaded it; the copy degrades on its own.
function notificationContextForEvent(event: ArchcarEvent): NotificationContext {
  const threadId = notificationThreadId(event);
  if (threadId == null) return {};
  for (const [workspace, threads] of Object.entries(threadsStore.state.byWorkspace)) {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (thread) {
      return {
        workspace,
        chatTitle: thread.title,
        model: thread.model,
        provider: thread.provider,
      };
    }
  }
  return {};
}

/// The chat an event is about, for the context lookup and the focus gate.
function notificationThreadId(event: ArchcarEvent): number | undefined {
  if (event.type === "provider_interaction_requested") {
    return (event as { interaction: { thread_id: number } }).interaction.thread_id;
  }
  return (event as { thread_id?: number }).thread_id;
}

/// Whether an OS banner for this event would land on top of what is already
/// on screen. A chat you are looking at narrates its own turn ending, so a
/// banner there is pure noise -- but a turn finishing in *another* workspace
/// is the whole reason to run several at once, and used to stay silent
/// whenever the window happened to be focused.
function notificationIsRedundant(event: ArchcarEvent): boolean {
  if (!nav.windowFocused()) return false;
  const threadId = notificationThreadId(event);
  if (threadId == null) return true;
  return nav.activePage() === "workspace" && nav.chatThreadInView(threadId);
}

const ATTENTION_EVENTS: ReadonlySet<string> = new Set([
  "turn_completed",
  "session_error",
  "session_exited",
  "provider_interaction_requested",
  "provider_interaction_resolved",
  "background_task_updated",
  "chat_queue_updated",
  // PR refreshes and workspace updates both publish this, and either can
  // change `pr_open`/`diff_ready`/`checks_failed` rows (a merged PR, say).
  // Without it, Attention keeps showing a merged PR as waiting-for-review
  // until something else happens to invalidate it.
  "inventory_changed",
]);

export function applyEvent(event: ArchcarEvent) {
  const notification = notificationIsRedundant(event)
    ? null
    : notificationForArchcarEvent(event, notificationContextForEvent(event));
  if (notification) void notify(notification);

  // Each of these can change what needs the human's attention. The store
  // debounces, so a burst of them costs one `list_attention`.
  if (ATTENTION_EVENTS.has(event.type)) attentionStore.invalidate();

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
      // No inventory refresh: a queued input changes the chat, not the
      // workspace list. iOS leaves this event out of
      // `WorkspacesStore.invalidates(_:)` for the same reason.
      chatRefresh.request((event as { thread_id: number }).thread_id);
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
      requestWorkspaceRefresh(threadsStore.workspaceForThread(e.thread_id) ?? e.workspace);
      break;
    }

    case "session_exited": {
      // Clear the exited session so running/busy spinners don't stick on.
      for (const threadId of chatStore.markSessionExited((event as { session_id: number }).session_id)) {
        observeChatGeneration(threadId);
      }
      requestInventoryRefresh();
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
      requestWorkspaceRefresh(threadsStore.workspaceForThread(e.thread_id));
      break;
    }

    case "turn_completed": {
      const e = event as { thread_id: number };
      noteTurnCompleted(e.thread_id);
      // The end of a turn is the state the user reads; never sit on it.
      chatRefresh.flush(e.thread_id);
      flushInventoryRefresh(threadsStore.workspaceForThread(e.thread_id));
      break;
    }

    case "session_error": {
      const e = event as { thread_id?: number; message: string };
      if (e.thread_id != null) chatStore.setPhase(e.thread_id, { kind: "failed", message: e.message });
      break;
    }

    case "background_task_updated": {
      requestInventoryRefresh();
      break;
    }

    case "summary_updated": {
      intelStore.refreshWorkspaceIntel((event as { workspace: string }).workspace);
      break;
    }

    case "task_updated": {
      // Task counts feed the sidebar rows and the Summary tab badge.
      intelStore.refreshWorkspaceIntel((event as { workspace: string }).workspace);
      requestInventoryRefresh();
      break;
    }

    case "workspace_renamed": {
      // The naming pipeline renamed this workspace server-side (first-message
      // agent metadata, or a pull request title). Everything here keys off the
      // name, so re-point selection before reloading or the open workspace goes
      // blank.
      const e = event as { old_name: string; new_name: string };
      nav.renameWorkspace(e.old_name, e.new_name);
      requestInventoryRefresh();
      break;
    }

    case "chat_thread_renamed": {
      // Retitled from agent metadata; the tab strip reads the thread list.
      requestWorkspaceRefresh(
        threadsStore.workspaceForThread((event as { thread_id: number }).thread_id),
      );
      break;
    }

    case "inventory_changed": {
      const e = event as { scope: string; workspace?: string };
      if (e.scope === "repositories") {
        requestInventoryRefresh();
      } else if (e.workspace) {
        requestWorkspaceRefresh(e.workspace);
      } else {
        requestInventoryRefresh();
      }
      break;
    }

    default:
      // session_screen_updated, session_exited, etc. handled by the surfaces that
      // care (e.g. terminal) once those pages exist.
      break;
  }
}
