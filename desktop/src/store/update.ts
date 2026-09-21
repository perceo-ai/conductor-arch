import { createSignal } from "solid-js";

import { installUpdate, onUpdateReady, updateState, type UpdateReady } from "@/bridge/client";
import { logAction, logState } from "@/lib/log";
import { toastsStore } from "./toasts";
import { workspacesStore } from "./workspaces";

// The app-update prompt.
//
// The main process decides *whether* there is an update and whether it can be
// installed in place (electron/updater.ts). This decides *when* to say so:
// never while an agent is working. Interrupting a running agent to restart the
// app is the one thing an update prompt must not do, so the toast waits for
// the last one to stop — however long that takes.

/** Remembered per version, so dismissing is not re-asked on the next tick. */
const DISMISSED_KEY = "archductor.update.dismissed.v1";

interface IdleRow {
  activeSessions: number;
  runRunning: boolean;
}

/** "All agents stopped": no agent session anywhere, and no run script either.
 *  Archived workspaces are included — a session in one is still a session. */
export function allAgentsStopped(rows: IdleRow[]): boolean {
  return rows.every((row) => row.activeSessions === 0 && !row.runRunning);
}

export interface OfferInput {
  ready: UpdateReady | null;
  /** False until the workspace inventory has loaded once. An empty store looks
   *  exactly like an idle one, and offering before the first load raced the
   *  toast in ahead of any running agent. */
  inventoryLoaded: boolean;
  agentsStopped: boolean;
  /** Version the user already dismissed, if any. */
  dismissedVersion: string | null;
  /** Version already showing (or shown) this run. */
  offeredVersion: string | null;
}

export function shouldOfferUpdate({
  ready,
  inventoryLoaded,
  agentsStopped,
  dismissedVersion,
  offeredVersion,
}: OfferInput): boolean {
  if (!ready) return false;
  if (!inventoryLoaded) return false;
  if (!agentsStopped) return false;
  if (ready.version === dismissedVersion) return false;
  if (ready.version === offeredVersion) return false;
  return true;
}

/** Toast wording follows the mode: promising a restart on a build that cannot
 *  self-install would be a lie. */
export function updateToastCopy(ready: UpdateReady): { message: string; label: string } {
  return ready.mode === "install"
    ? { message: `Archductor ${ready.version} is ready to install`, label: "Restart to update" }
    : { message: `Archductor ${ready.version} is available`, label: "Download" };
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // A blocked localStorage only costs us the "don't ask again" memory.
  }
}

const [ready, setReady] = createSignal<UpdateReady | null>(null);
let offeredVersion: string | null = null;
let wired = false;

export const updateStore = {
  ready,

  /** Subscribe to the main process. Idempotent. */
  async start(): Promise<void> {
    if (wired) return;
    wired = true;
    onUpdateReady((next) => {
      logState("update ready", { version: next.version, mode: next.mode });
      setReady(next);
    });
    // The check can win the race against the renderer mounting, so ask for
    // anything already found rather than waiting for an event that has passed.
    const existing = await updateState().catch(() => null);
    if (existing) setReady(existing);
  },

  /**
   * Offer the update if one is pending and nothing is running. Safe to call on
   * every state change: it pushes at most one toast per version.
   */
  evaluate(): void {
    const pending = ready();
    const rows = workspacesStore.state.order
      .map((name) => workspacesStore.state.byName[name])
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    const input: OfferInput = {
      ready: pending,
      inventoryLoaded: workspacesStore.loaded(),
      agentsStopped: allAgentsStopped(rows),
      dismissedVersion: readDismissed(),
      offeredVersion,
    };
    if (!shouldOfferUpdate(input) || !pending) return;

    offeredVersion = pending.version;
    const { message, label } = updateToastCopy(pending);
    // Sticky (ttl 0): an update the user has not answered should not scroll
    // past while they are reading something else.
    toastsStore.push(
      message,
      "info",
      0,
      {
        label,
        run: () => {
          logAction("update install", { version: pending.version, mode: pending.mode });
          void installUpdate();
        },
      },
      // Answered — by acting or by closing — so don't raise this version again,
      // in this run or the next. A newer release asks afresh.
      () => writeDismissed(pending.version),
    );
  },

  /** Test seam: forget what this session has already offered. */
  resetForTests(): void {
    setReady(null);
    offeredVersion = null;
    wired = false;
    try {
      localStorage.removeItem(DISMISSED_KEY);
    } catch {
      // ignore
    }
  },

  /** Test seam: inject a pending update without the IPC round trip. */
  setReadyForTests(next: UpdateReady | null): void {
    setReady(next);
  },
};
