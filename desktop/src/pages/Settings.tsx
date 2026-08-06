import { For, Show, createEffect, createResource, createSignal } from "solid-js";
import { repositoriesStore, prefsStore } from "@/store";
import { ACCENT_HEX } from "@/store/prefs";
import { send } from "@/bridge/client";
import { MODELS, CHAT_PROVIDERS } from "@/lib/models";

// Settings page — two panes per scope:
//   Effective : the merged, read-only config (get_settings) for reference.
//   Source    : the raw editable TOML for one layer (get_settings_source),
//               saved back through save_settings (validated server-side).
// Global scope edits the app-shared layer; a repository scope edits either its
// committed ("repository") or "local" override layer.

type Layer = "repository" | "local";

export function SettingsPage() {
  // undefined scope = global; otherwise a repository name.
  const [repo, setRepo] = createSignal<string | undefined>(undefined);
  const [layer, setLayer] = createSignal<Layer>("repository");

  const [effective, { refetch: refetchEffective }] = createResource(
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

  const [source, { refetch: refetchSource }] = createResource(
    () => [repo() ?? "\0global", repo() ? layer() : "global"] as const,
    async (): Promise<string> => {
      try {
        const res = await send({
          type: "get_settings_source",
          repository: repo(),
          layer: repo() ? layer() : undefined,
        });
        return res.type === "settings_source" ? res.toml : "";
      } catch (err) {
        return `# failed to load source: ${(err as Error).message}`;
      }
    },
  );

  // Available prompt packs for the selected repository (read-only discovery;
  // switch by editing `[prompt_pack] active` in the source editor below).
  const [promptPacks] = createResource(
    () => repo(),
    async (repository): Promise<{ packs: string[]; active?: string }> => {
      try {
        const res = await send({ type: "list_prompt_packs", repository });
        return res.type === "prompt_packs" ? { packs: res.packs, active: res.active } : { packs: [] };
      } catch {
        return { packs: [] };
      }
    },
  );

  const [draft, setDraft] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal("");
  // Reset the editor draft whenever a fresh source load arrives.
  createEffect(() => {
    const s = source();
    if (s != null) {
      setDraft(s);
      setStatus("");
    }
  });
  const dirty = () => draft() != null && draft() !== source();

  async function save() {
    const toml = draft();
    if (toml == null) return;
    setStatus("Saving…");
    try {
      const res = await send({
        type: "save_settings",
        repository: repo(),
        layer: repo() ? layer() : undefined,
        toml,
      });
      if (res.type === "settings_saved") {
        setStatus("Saved");
        await Promise.all([refetchSource(), refetchEffective()]);
      } else if (res.type === "error") {
        setStatus(`Save failed: ${res.message}`);
      } else {
        setStatus("Save failed");
      }
    } catch (err) {
      setStatus(`Save failed: ${(err as Error).message}`);
    }
  }

  return (
    <div class="page-shell">
      <div class="page-header dashboard-header">
        <div class="dashboard-title">Settings</div>
        <div class="dashboard-subtitle">
          Edit a layer's source below; the effective column shows the merged result.
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
        <div class="settings-appearance">
          <div class="settings-appearance-group">
            <span class="settings-field-title">Theme</span>
            <div class="command-center-strip">
              <For each={["dark", "light"] as const}>
                {(t) => (
                  <button
                    class="nav-button"
                    classList={{ "nav-button-active": prefsStore.state.theme === t }}
                    onClick={() => prefsStore.setTheme(t)}
                  >
                    {t === "dark" ? "Dark" : "Light"}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="settings-appearance-group">
            <span class="settings-field-title">Accent</span>
            <div class="command-center-strip">
              <For each={["amber", "blue", "green", "rose"] as const}>
                {(a) => (
                  <button
                    class="nav-button settings-accent-swatch"
                    classList={{ "nav-button-active": prefsStore.state.accent === a }}
                    style={{ "--swatch": ACCENT_HEX[a] }}
                    onClick={() => prefsStore.setAccent(a)}
                  >
                    <span class="settings-accent-dot" />
                    {a[0].toUpperCase() + a.slice(1)}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="settings-appearance-group">
            <span class="settings-field-title">Density</span>
            <div class="command-center-strip">
              <For each={["compact", "cozy", "comfortable"] as const}>
                {(d) => (
                  <button
                    class="nav-button"
                    classList={{ "nav-button-active": prefsStore.state.density === d }}
                    onClick={() => prefsStore.setDensity(d)}
                  >
                    {d[0].toUpperCase() + d.slice(1)}
                  </button>
                )}
              </For>
            </div>
          </div>
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
        <Show when={repo() !== undefined && (promptPacks()?.packs.length ?? 0) > 0}>
          <div class="settings-prompt-packs">
            <span class="settings-field-title">Prompt packs</span>
            <div class="settings-pack-chips">
              <For each={promptPacks()?.packs ?? []}>
                {(pack) => (
                  <span
                    class="settings-pack-chip"
                    classList={{ "settings-pack-chip-active": promptPacks()?.active === pack }}
                    title={
                      promptPacks()?.active === pack
                        ? "Active pack"
                        : "Switch by setting [prompt_pack] active in the source below"
                    }
                  >
                    {pack}
                    <Show when={promptPacks()?.active === pack}> ✓</Show>
                  </span>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={repo() !== undefined}>
          <div class="command-center-strip settings-layer-strip">
            <button
              class="nav-button"
              classList={{ "nav-button-active": layer() === "repository" }}
              onClick={() => setLayer("repository")}
            >
              Repository
            </button>
            <button
              class="nav-button"
              classList={{ "nav-button-active": layer() === "local" }}
              onClick={() => setLayer("local")}
            >
              Local
            </button>
          </div>
        </Show>
      </div>

      <div class="settings-split">
        <div class="settings-pane">
          <div class="settings-pane-head">
            <span class="section-title">
              Source — {repo() === undefined ? "app shared" : layer()}
            </span>
            <span class="card-meta">{status() || (dirty() ? "Unsaved changes" : "")}</span>
            <button class="suggested-action" disabled={!dirty()} onClick={() => void save()}>
              Save
            </button>
          </div>
          <textarea
            class="settings-source-area"
            spellcheck={false}
            value={draft() ?? ""}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              setStatus("");
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                void save();
              }
            }}
          />
        </div>
        <div class="settings-pane">
          <div class="settings-pane-head">
            <span class="section-title">Effective (read-only)</span>
          </div>
          <div class="ws-diff-view">
            <Show when={!effective.loading} fallback={<div class="empty-state">Loading…</div>}>
              <pre class="ws-diff-text">{effective()}</pre>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
