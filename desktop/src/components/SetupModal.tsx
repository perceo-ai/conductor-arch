import { createResource, createSignal, Show } from "solid-js";

import { setupStore } from "@/store";
import { remoteDaemon } from "@/bridge/client";
import { SetupStatusList } from "./SetupReadiness";

// Blocking first-run setup gate. Shown while archcar reports outstanding setup
// blockers (GitHub CLI + a signed-in Codex/Claude). Ported from the retired GTK
// `show_blocking_setup_if_needed` modal; the readiness rows and feedback text
// come from the backend so both surfaces stay in sync.
//
// The rows describe whichever daemon this machine is pointed at. When that is a
// remote, the tools it wants are the *server's* — and the Settings card that
// would let you point somewhere else sits behind this scrim. So the modal
// carries its own way out; without it a client connected to a server missing
// `gh`/Codex/Claude can only be recovered from a terminal.

export default function SetupModal() {
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [remote, { refetch: refetchRemote }] = createResource(async () => {
    try {
      const res = await remoteDaemon.get();
      return res.ok && res.address ? res : null;
    } catch {
      return null;
    }
  });

  const onRecheck = async () => {
    setError(null);
    try {
      const report = await setupStore.recheck();
      if (report.refresh_error) {
        setError(
          `${report.refresh_error} Restart Archductor if the tool was just installed.`,
        );
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onDisconnect = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await remoteDaemon.clear();
      if (!res.ok) {
        setError(res.error ?? "Could not disconnect from the remote daemon.");
        return;
      }
      await refetchRemote();
      // Re-probe against the local daemon: the rows on screen describe the
      // remote we just left.
      await setupStore.recheck();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={setupStore.blocked()}>
      <div class="modal-scrim setup-scrim">
        <div class="modal-body setup-modal">
          <div class="setup-title">Finish setup</div>
          <p class="setup-copy">
            <Show
              when={remote()?.address}
              fallback="Archductor needs the GitHub CLI and at least one signed-in coding agent before chat features can run."
            >
              {`These tools are checked on the remote daemon at ${remote()?.address}, not on this machine. Install or authenticate them there, or disconnect to use this machine instead.`}
            </Show>
          </p>

          <SetupStatusList rows={setupStore.report()?.rows ?? []} />

          <p class="setup-feedback">
            {setupStore.report()?.feedback ?? "Checking your setup…"}
          </p>
          <Show when={error()}>
            <p class="setup-feedback setup-error">{error()}</p>
          </Show>

          <div class="setup-actions">
            <Show when={remote()?.source === "profile"}>
              <button class="ui-button-secondary" disabled={busy()} onClick={() => void onDisconnect()}>
                Disconnect
              </button>
            </Show>
            <Show when={remote()?.source === "environment"}>
              <p class="setup-feedback">
                ARCHDUCTOR_ARCHCAR_REMOTE points this app at {remote()?.address}; unset it to use
                this machine.
              </p>
            </Show>
            <button
              class="ui-button-primary"
              disabled={setupStore.checking() || busy()}
              onClick={() => void onRecheck()}
            >
              {setupStore.checking() ? "Checking…" : "Recheck"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
