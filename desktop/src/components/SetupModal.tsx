import { createResource, createSignal, Show } from "solid-js";

import { setupStore } from "@/store";
import { remoteDaemon } from "@/bridge/client";
import { SetupStatusList } from "./SetupReadiness";
import { PermissionCard } from "./PermissionCard";

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

  // Denied folders are worth the gate on their own. They do not block chat, so
  // `blocked()` is false for them — but "add a repository" is the first thing a
  // new user does, and it is exactly what a denial breaks. Asking at first open
  // is the whole point of the permission flow.
  const deniedRoots = () =>
    (setupStore.report()?.file_access ?? []).filter((probe) => probe.state === "denied");

  // A denial keeps chat working, so the gate it raises has to be escapable.
  // Dismissal lasts for this run: the card comes back next launch, and the
  // "File access" readiness row keeps saying so in the meantime.
  //
  // "Only file access" covers the blocking case too. A denied root belonging to
  // an already-added repository makes readiness incomplete, and holding the
  // user behind the scrim for it is a trap: the controls that would let them
  // remove that repository are on the other side of the modal.
  const [dismissed, setDismissed] = createSignal(false);
  const fileAccessOnly = () => {
    if (deniedRoots().length === 0) return false;
    const rows = setupStore.report()?.rows ?? [];
    return rows.every((row) => row.state === "ready" || row.action === "grant_file_access");
  };

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
    <Show when={(setupStore.blocked() || fileAccessOnly()) && !(fileAccessOnly() && dismissed())}>
      <div class="modal-scrim setup-scrim">
        <div class="modal-body setup-modal">
          <div class="setup-title">Finish setup</div>
          <p class="setup-copy">
            <Show
              when={remote()?.address}
              fallback={
                fileAccessOnly()
                  ? "Archductor needs permission to read the folders your repositories live in."
                  : "Archductor needs the GitHub CLI and at least one signed-in coding agent before chat features can run."
              }
            >
              {`These tools are checked on the remote daemon at ${remote()?.address}, not on this machine. Install or authenticate them there, or disconnect to use this machine instead.`}
            </Show>
          </p>

          <SetupStatusList rows={setupStore.report()?.rows ?? []} />

          <PermissionCard
            probes={setupStore.report()?.file_access ?? []}
            remoteAddress={remote()?.address ?? null}
            onPoll={() => setupStore.recheck()}
          />

          <p class="setup-feedback">
            {setupStore.report()?.feedback ?? "Checking your setup…"}
          </p>
          <Show when={error()}>
            <p class="setup-feedback setup-error">{error()}</p>
          </Show>

          <div class="setup-actions">
            <Show when={fileAccessOnly()}>
              <button class="ui-button-secondary" onClick={() => setDismissed(true)}>
                Not now
              </button>
            </Show>
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
