import { doNotDisturb } from "@/bridge/client";
import { createGenerationEdgeDetector, isChatGenerating } from "@/lib/chatBusy";
import { playTurnSound } from "@/lib/turnSoundPlayer";
import { chatStore } from "./chat";
import { daemonEpoch } from "./daemonEpoch";
import { interactionsStore } from "./interactions";
import { nav } from "./nav";
import { prefsStore } from "./prefs";

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

export interface TurnSoundGate {
  enabled: boolean;
  suppressWhenViewing: boolean;
  /** The operator is looking at this chat in a focused window. */
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
    viewing:
      nav.windowFocused() &&
      nav.activePage() === "workspace" &&
      nav.chatThreadInView(threadId),
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

/** Re-evaluate one chat; plays the sound if it just stopped generating. */
export function observeChatGeneration(threadId: number, opts: ObserveOptions = {}): void {
  if (daemonEpoch() !== edgesEpoch) {
    edges.reset();
    edgesEpoch = daemonEpoch();
  }
  const generating = chatGenerating(threadId);
  if (!generating && opts.canFinish === false) return;
  if (!edges.observe(threadId, generating)) return;
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

