import { For, Show, createSignal } from "solid-js";

import { fileAccess } from "@/bridge/client";
import type { FileAccessProbe } from "@/bridge/protocol";

// macOS denies a launchd-started daemon the protected folders silently, and
// offers no API to ask. The pane is the only route, so this card walks it:
// reveal the binary, open the pane, restart the daemon once the grant lands.
//
// The daemon may be somewhere else entirely. A grant made on this machine would
// do nothing for a remote host, so the buttons are withheld and the card says
// where the work has to happen.

/** True when a daemon error is macOS refusing it a path. */
export function isPermissionError(message: string): boolean {
  return message.includes("Full Disk Access");
}

export function PermissionCard(props: {
  probes: FileAccessProbe[];
  remoteAddress: string | null;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const roots = () => props.probes.filter((probe) => probe.state === "denied");

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
          <ol class="permission-steps">
            <li>Reveal the daemon binary in Finder.</li>
            <li>Open Settings and drag it into Full Disk Access.</li>
            <li>Restart the daemon.</li>
          </ol>
          <div class="permission-actions">
            <button
              class="ui-button-secondary"
              disabled={busy()}
              onClick={() => void run(fileAccess.revealDaemon)}
            >
              Reveal daemon
            </button>
            <button
              class="ui-button-secondary"
              disabled={busy()}
              onClick={() => void run(fileAccess.openSettings)}
            >
              Open Settings ↗
            </button>
            <button
              class="ui-button-primary"
              disabled={busy()}
              onClick={() => void run(fileAccess.restartDaemon)}
            >
              Restart daemon
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
