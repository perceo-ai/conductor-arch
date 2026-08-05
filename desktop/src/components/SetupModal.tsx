import { createSignal, For, Show } from "solid-js";

import { setupStore } from "@/store";
import { openExternal } from "@/bridge/client";
import type { SetupRow, SetupRowState } from "@/bridge/protocol";

// Blocking first-run setup gate. Shown while archcar reports outstanding setup
// blockers (GitHub CLI + a signed-in Codex/Claude). Ported from the retired GTK
// `show_blocking_setup_if_needed` modal; the readiness rows and feedback text
// come from the backend so both surfaces stay in sync.

const INSTALL_LINKS: Record<string, string> = {
  "GitHub CLI": "https://cli.github.com/",
  Codex: "https://developers.openai.com/codex/cli",
  Claude: "https://docs.anthropic.com/en/docs/claude-code",
  OpenCode: "https://opencode.ai/",
};

const STATE_LABEL: Record<SetupRowState, string> = {
  ready: "Ready",
  action: "Action",
  missing: "Missing",
};

function rowClass(row: SetupRow): string {
  if (row.state === "ready") return "setup-status-ready";
  return row.required ? "setup-status-missing-required" : "setup-status-missing";
}

function StatusRow(props: { row: SetupRow }) {
  const link = () => INSTALL_LINKS[props.row.name];
  return (
    <div class={`setup-status-row ${rowClass(props.row)}`}>
      <span class={`setup-status-pill setup-pill-${props.row.state}`}>
        {STATE_LABEL[props.row.state]}
      </span>
      <div class="setup-status-text">
        <span class="setup-status-name">{props.row.name}</span>
        <span class="setup-status-detail">{props.row.detail}</span>
      </div>
      <Show when={props.row.state !== "ready" && link()}>
        {/* Electron blocks target=_blank / window.open by default, so route the
            install link through the shell:open-external IPC instead of an <a>. */}
        <button class="setup-link" onClick={() => void openExternal(link()!)}>
          Install ↗
        </button>
      </Show>
    </div>
  );
}

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

          <div class="setup-status-list">
            <For each={setupStore.report()?.rows ?? []}>
              {(row) => <StatusRow row={row} />}
            </For>
          </div>

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
