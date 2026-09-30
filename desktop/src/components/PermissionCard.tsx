import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

import { fileAccess } from "@/bridge/client";
import type { FileAccessProbe } from "@/bridge/protocol";

// macOS denies a launchd-started daemon the protected folders silently, and
// offers no API that prompts for Full Disk Access. The daemon's probe already
// listed it in the pane (toggle off), so asking is one click: open the pane,
// and when the user comes back to this window, restart the daemon so the grant
// takes effect. Revealing the binary stays as a fallback for when it is not
// listed.
//
// The daemon may be somewhere else entirely. A grant made on this machine would
// do nothing for a remote host, so the buttons are withheld and the card says
// where the work has to happen.

const POLL_MS = 2000;

/** True when a daemon error is macOS refusing it a path. */
export function isPermissionError(message: string): boolean {
  return message.includes("Full Disk Access");
}

export function PermissionCard(props: {
  probes: FileAccessProbe[];
  remoteAddress: string | null;
  /** Re-probe the daemon; polled while the card is up. Omitted where the
   *  probes are synthetic, as in a failed "add repository". */
  onPoll?: () => Promise<unknown>;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const roots = () => props.probes.filter((probe) => probe.state === "denied");

  // Set once the pane is open: the next time this window gains focus, the user
  // is back from System Settings and the daemon needs a restart to see it.
  const [awaitingGrant, setAwaitingGrant] = createSignal(false);

  // A grant happens in System Settings, outside this app, with no event to
  // listen for, so the card polls to clear itself. The poll lives here because
  // this component exists only while something is denied — and it chains off
  // the previous answer rather than firing on a timer, because a recheck runs
  // subprocess probes that can outlast the interval and pile up.
  onMount(() => {
    if (!props.onPoll) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await props.onPoll!();
      } catch {
        // A failed recheck is not worth surfacing; the next one may work.
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    onCleanup(() => {
      stopped = true;
      if (timer) clearTimeout(timer);
    });
  });

  onMount(() => {
    const onFocus = () => {
      if (!awaitingGrant()) return;
      // Disarmed while the restart runs, so another focus does not start a
      // second one; re-armed if it fails, so coming back again retries it.
      setAwaitingGrant(false);
      void run(async () => {
        // A rejected call is a failed restart too, and must re-arm the same way.
        const res = await fileAccess
          .restartDaemon()
          .catch((err: unknown) => ({ ok: false, error: String(err) }));
        if (!res.ok) {
          setAwaitingGrant(true);
          return res;
        }
        await props.onPoll?.().catch(() => undefined);
        return res;
      });
    };
    window.addEventListener("focus", onFocus);
    onCleanup(() => window.removeEventListener("focus", onFocus));
  });

  const allow = async () => {
    const res = await fileAccess.openSettings();
    if (res.ok) setAwaitingGrant(true);
    return res;
  };

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    setBusy(true);
    try {
      const res = await action();
      if (!res.ok) setError(res.error ?? "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={roots().length > 0}>
      <div class="permission-card">
        <div class="permission-title">File access</div>
        <p class="permission-copy">
          <Show
            when={props.remoteAddress}
            fallback="macOS is blocking the Archductor daemon from these folders. Repositories inside them cannot be added until it is allowed."
          >
            {`The daemon at ${props.remoteAddress} is blocked from these folders. The permission has to be granted on that machine.`}
          </Show>
        </p>
        <ul class="permission-roots">
          <For each={roots()}>{(probe) => <li>{probe.root}</li>}</For>
        </ul>
        <Show when={!props.remoteAddress}>
          <p class="permission-copy">
            Turn on <strong>archcar</strong> in Full Disk Access, then come back here. The daemon
            restarts on its own.
          </p>
          <div class="permission-actions">
            <button class="ui-button-primary" disabled={busy()} onClick={() => void run(allow)}>
              Allow access ↗
            </button>
            <button
              class="ui-button-secondary"
              disabled={busy()}
              title="If archcar is not in the list, drag it in from Finder."
              onClick={() => void run(fileAccess.revealDaemon)}
            >
              Not listed? Reveal daemon
            </button>
          </div>
        </Show>
        <Show when={error()}>
          <p class="setup-feedback setup-error">{error()}</p>
        </Show>
      </div>
    </Show>
  );
}
