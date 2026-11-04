import { doNotDisturb } from "@/bridge/client";
import { createGenerationEdgeDetector, isChatGenerating } from "@/lib/chatBusy";
import { playTurnSound } from "@/lib/turnSoundPlayer";
import { chatStore } from "./chat";
import { daemonEpoch } from "./daemonEpoch";
import { interactionsStore } from "./interactions";
import { nav } from "./nav";
import { prefsStore } from "./prefs";
import { threadsStore } from "./threads";

// The "a chat needs you" sound. One selector says whether a chat is still
// working (main agent OR any subagent); one detector turns that into a single
// falling edge per busy → idle transition; this module decides whether that
// edge is audible. The reducer calls `observeChatGeneration` after every store
// write that can move a chat's busy state, for every chat, viewed or not.

/** Single source of truth for "is this chat still generating?". Reactive. */
export function chatGenerating(threadId: number): boolean {
  const slice = chatStore.slice(threadId);
  return isChatGenerating({
    session: slice.session,
    phase: slice.phase,
    blockedOnUser: interactionsStore.pending(threadId) != null,
    projection: slice.projection,
  });
}

/**
 * This chat finished and the operator has not seen it yet. Reactive. A chat
 * that went back to work, or is parked on a question, says so itself.
 */
export function chatAwaitingAcknowledgement(threadId: number): boolean {
  return (
    chatStore.slice(threadId).completedTurnAttention &&
    !chatGenerating(threadId) &&
    interactionsStore.pending(threadId) == null
  );
}

/** Any chat in this workspace is waiting to be acknowledged. Reactive. */
export function workspaceAwaitingAcknowledgement(workspace: string): boolean {
  return threadsStore.list(workspace).some((thread) => chatAwaitingAcknowledgement(thread.id));
}

export interface TurnSoundGate {
  enabled: boolean;
  suppressWhenViewing: boolean;
  /** This is the focused pane's chat, in a focused window. */
  viewing: boolean;
}

export function shouldPlayTurnSound(gate: TurnSoundGate): boolean {
  if (!gate.enabled) return false;
  if (gate.suppressWhenViewing && gate.viewing) return false;
  return true;
}

const edges = createGenerationEdgeDetector();
// Thread ids are per daemon. After a switch, thread 1 is a different chat, so
// its "was busy" from the old daemon must not meet "is idle" on the new one.
let edgesEpoch = daemonEpoch();

function currentGate(threadId: number): TurnSoundGate {
  return {
    enabled: prefsStore.state.turnSound,
    suppressWhenViewing: prefsStore.state.turnSoundSuppressWhenViewing,
    viewing: nav.chatThreadFocused(threadId),
  };
}

export interface ObserveOptions {
  /**
   * The state read is current enough to call the chat finished. When false an
   * idle reading is ignored entirely (neither fires nor overwrites a busy
   * baseline), while a busy reading is still recorded.
   */
  canFinish?: boolean;
}

function syncEdgesEpoch(): void {
  if (daemonEpoch() !== edgesEpoch) {
    edges.reset();
    edgesEpoch = daemonEpoch();
  }
}

/**
 * The daemon says a turn ended, so this chat was busy whatever the pulls saw: a
 * short turn on a session already up has no `session_started` and can fall
 * between two pulls, and nothing here sent it when it came from the queue. The
 * settled pull that follows judges the finish. A chat with no session has
 * already had its edge from `session_exited`.
 */
export function noteTurnCompleted(threadId: number): void {
  syncEdgesEpoch();
  if (chatStore.slice(threadId).session == null) return;
  edges.observe(threadId, true);
}

/** Re-evaluate one chat; flags it and plays the sound if it just stopped generating. */
export function observeChatGeneration(threadId: number, opts: ObserveOptions = {}): void {
  syncEdgesEpoch();
  const generating = chatGenerating(threadId);
  if (!generating && opts.canFinish === false) return;
  if (!edges.observe(threadId, generating)) return;
  // Set even for the chat on screen: the surface showing it clears the flag
  // the moment the operator can see it, which is the one place that knows.
  chatStore.setCompletedTurnAttention(threadId, true);
  if (!shouldPlayTurnSound(currentGate(threadId))) return;
  void (async () => {
    // Do-not-disturb is asked at play time, not cached: it is the operator's
    // state right now that matters, and the check is cheap next to a turn.
    if (await doNotDisturb()) return;
    // The check above can take up to a second (gsettings timeout). Muting, or
    // opening the chat with quiet mode on, during it must still win.
    if (!shouldPlayTurnSound(currentGate(threadId))) return;
    playTurnSound();
  })();
}

