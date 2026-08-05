import { For, Show, createResource, createSignal } from "solid-js";
import { repositoriesStore, prefsStore } from "@/store";
import { send } from "@/bridge/client";
import { MODELS, CHAT_PROVIDERS } from "@/lib/models";

// Settings page — read-only view of the effective settings (global app layer or
// a repository's merged layers), rendered as TOML. A structured editor
// (save_settings + per-field controls) is future work; this de-placeholders the
// page with the real, authoritative config.

export function SettingsPage() {
  // undefined scope = global; otherwise a repository name.
  const [repo, setRepo] = createSignal<string | undefined>(undefined);

  const [settings] = createResource(
    () => repo() ?? "\0global",
    async (): Promise<string> => {
      try {
        const res = await send({ type: "get_settings", repository: repo() });
        return res.type === "settings" ? res.toml : "";
      } catch (err) {
        return `# failed to load settings: ${(err as Error).message}`;
      }
    },
  );

  return (
    <div class="page-shell">
      <div class="page-header dashboard-header">
        <div class="dashboard-title">Settings</div>
        <div class="dashboard-subtitle">
          Effective configuration (read-only). Editing is coming soon.
        </div>
        <div class="settings-field">
          <div class="settings-field-title">Default model for new chats</div>
          <select
            id="default-model"
            class="chat-picker"
            value={prefsStore.state.defaultModel}
            onChange={(e) => prefsStore.setDefaultModel(e.currentTarget.value)}
          >
            <For each={CHAT_PROVIDERS}>
              {(provider) => (
                <optgroup label={provider}>
                  <For each={MODELS[provider] ?? []}>
                    {(m) => <option value={m}>{m}</option>}
                  </For>
                </optgroup>
              )}
            </For>
          </select>
        </div>
        <div class="project-tabs">
          <button
            class="ws-tab-shell"
            classList={{ "ws-tab-active": repo() === undefined }}
            onClick={() => setRepo(undefined)}
          >
            <span class="ws-tab-label">Global</span>
          </button>
          <For each={repositoriesStore.state.order}>
            {(name) => (
              <button
                class="ws-tab-shell"
                classList={{ "ws-tab-active": repo() === name }}
                onClick={() => setRepo(name)}
              >
                <span class="ws-tab-label">{name}</span>
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="ws-diff-view">
        <Show when={!settings.loading} fallback={<div class="empty-state">Loading…</div>}>
          <pre class="ws-diff-text">{settings()}</pre>
        </Show>
      </div>
    </div>
  );
}
