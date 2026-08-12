import { createSignal, Show } from "solid-js";

import { setupStore } from "@/store";
import { SetupStatusList } from "./SetupReadiness";

// Blocking first-run setup gate. Shown while archcar reports outstanding setup
// blockers (GitHub CLI + a signed-in Codex/Claude). Ported from the retired GTK
// `show_blocking_setup_if_needed` modal; the readiness rows and feedback text
// come from the backend so both surfaces stay in sync.

export default function SetupModal() {
  const [error, setError] = createSignal<string | null>(null);

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

  return (
    <Show when={setupStore.blocked()}>
      <div class="modal-scrim setup-scrim">
        <div class="modal-body setup-modal">
          <div class="setup-title">Finish setup</div>
          <p class="setup-copy">
            Archductor needs the GitHub CLI plus a signed-in Codex or Claude CLI before
            chat features can run.
          </p>

          <SetupStatusList rows={setupStore.report()?.rows ?? []} />

          <p class="setup-feedback">
            {setupStore.report()?.feedback ?? "Checking your setup…"}
          </p>
          <Show when={error()}>
            <p class="setup-feedback setup-error">{error()}</p>
          </Show>

          <div class="setup-actions">
            <button
              class="ui-button-primary"
              disabled={setupStore.checking()}
              onClick={onRecheck}
            >
              {setupStore.checking() ? "Checking…" : "Recheck"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
