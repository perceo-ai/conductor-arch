import { createSignal, For, Show } from "solid-js";

import { setupStore } from "@/store";
import { openExternal } from "@/bridge/client";
import type { SetupRow, SetupRowState } from "@/bridge/protocol";

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

export function SetupStatusRow(props: { row: SetupRow }) {
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
        <button class="setup-link" onClick={() => void openExternal(link()!)}>
          Install ↗
        </button>
      </Show>
    </div>
  );
}

export function SetupStatusList(props: { rows: SetupRow[] }) {
  return (
    <div class="setup-status-list">
      <For each={props.rows}>{(row) => <SetupStatusRow row={row} />}</For>
    </div>
  );
}

export function SetupReadinessCard() {
  const [error, setError] = createSignal<string | null>(null);

  const onRecheck = async () => {
    setError(null);
    try {
      const report = await setupStore.recheck();
      if (report.refresh_error) {
        setError(`${report.refresh_error} Restart Archductor if the tool was just installed.`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div class="settings-field settings-health-card settings-readiness-card">
      <div class="settings-card-head">
        <div>
          <div class="settings-field-title">System readiness</div>
          <div class="settings-status">
            {setupStore.report()?.complete
              ? "GitHub and a launchable agent provider are ready."
              : setupStore.report()?.feedback || "Check host tools and provider auth."}
          </div>
        </div>
        <span
          class="settings-readiness-pill"
          classList={{ "settings-readiness-pill-ready": setupStore.report()?.complete === true }}
        >
          {setupStore.report()?.complete ? "Ready" : "Action required"}
        </span>
      </div>
      <SetupStatusList rows={setupStore.report()?.rows ?? []} />
      <Show when={error()}>
        <div class="setup-feedback setup-error">{error()}</div>
      </Show>
      <div class="settings-action-row">
        <button class="ui-button-secondary" disabled={setupStore.checking()} onClick={onRecheck}>
          {setupStore.checking() ? "Checking..." : "Recheck tools"}
        </button>
      </div>
    </div>
  );
}
