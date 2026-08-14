import { For, Show, createEffect, createResource, createSignal } from "solid-js";
import { repositoriesStore, prefsStore } from "@/store";
import { ACCENT_HEX } from "@/store/prefs";
import { checkForUpdates, openExternal, send } from "@/bridge/client";
import { MODELS, CHAT_PROVIDERS } from "@/lib/models";
import { updateStatusText, type UpdateStatus } from "@/lib/update";
import { SetupReadinessCard } from "@/components/SetupReadiness";
import type { ServiceStatus } from "@/bridge/protocol";

// Settings page — two panes per scope:
//   Effective : the merged, read-only config (get_settings) for reference.
//   Source    : the raw editable TOML for one layer (get_settings_source),
//               saved back through save_settings (validated server-side).
// Global scope edits the app-shared layer; a repository scope edits either its
// committed ("repository") or "local" override layer.

type Layer = "repository" | "local";

// Background service + remote access. The daemon has to be running for the app,
// the CLI, and MCP clients to work, so the OS should keep it up; and a
// token-guarded TCP listener is what lets a client on another machine reach it.
function BackgroundServiceCard() {
  const [status, { refetch }] = createResource(async (): Promise<ServiceStatus | null> => {
    try {
      const res = await send({ type: "get_service_status" });
      return res.type === "service_status" ? res.status : null;
    } catch {
      return null;
    }
  });
  const [access, { refetch: refetchAccess }] = createResource(async () => {
    try {
      const res = await send({ type: "get_remote_access" });
      return res.type === "remote_access" ? res : null;
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = createSignal(false);
  const [feedback, setFeedback] = createSignal("");
  const [listen, setListen] = createSignal("7420");
  const [showToken, setShowToken] = createSignal(false);

  const supported = () => (status()?.manager ?? "unsupported") !== "unsupported";

  const stateText = () => {
    const current = status();
    if (!current) return "Could not read the service status.";
    if (!supported()) return "This platform has no supported per-user service manager.";
    if (!current.installed) return "Not installed — archductor starts the daemon on demand.";
    return `${current.manager}: ${current.running ? "running" : "installed, not running"}${
      current.listen ? ` · listening on ${current.listen}` : ""
    }`;
  };

  async function run(label: string, action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setFeedback(`${label}…`);
    try {
      await action();
      await Promise.all([refetch(), refetchAccess()]);
    } catch (err) {
      setFeedback(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const install = () =>
    run("Installing service", async () => {
      const res = await send({
        type: "install_service",
        input: { listen: listen().trim() || undefined },
      });
      setFeedback(res.type === "error" ? res.message : res.type === "service_status" ? res.status.detail : "");
    });

  const uninstall = () =>
    run("Removing service", async () => {
      const res = await send({ type: "uninstall_service" });
      setFeedback(res.type === "error" ? res.message : "Service removed.");
    });

  const rotate = () =>
    run("Rotating token", async () => {
      const res = await send({ type: "rotate_remote_token" });
      setFeedback(
        res.type === "error" ? res.message : "Token rotated — existing remote clients must update.",
      );
    });

  return (
    <div class="settings-field settings-health-card">
      <div class="settings-field-title">Background service &amp; remote access</div>
      <div class="settings-status">{stateText()}</div>
      <Show when={supported()}>
        <div class="settings-action-row">
          <input
            class="ws-text-input settings-listen-input"
            value={listen()}
            title="Port or host:port. A bare port listens on loopback only."
            onInput={(e) => setListen(e.currentTarget.value)}
          />
          <button class="ui-button-secondary" disabled={busy()} onClick={() => void install()}>
            {status()?.installed ? "Reinstall service" : "Install service"}
          </button>
          <Show when={status()?.installed}>
            <button class="ui-button-secondary" disabled={busy()} onClick={() => void uninstall()}>
              Remove service
            </button>
          </Show>
        </div>
      </Show>
      <Show when={access()}>
        {(remote) => (
          <>
            <div class="settings-status">
              Remote access token — anyone holding it can drive every workspace on this machine.
            </div>
            <div class="settings-action-row">
              <code class="settings-token">
                {showToken() ? remote().token : "•".repeat(24)}
              </code>
              <button class="ui-button-secondary" onClick={() => setShowToken((shown) => !shown)}>
                {showToken() ? "Hide" : "Reveal"}
              </button>
              <button class="ui-button-secondary" disabled={busy()} onClick={() => void rotate()}>
                Rotate
              </button>
            </div>
            <div class="settings-status settings-hint">
              On the other machine set ARCHDUCTOR_ARCHCAR_REMOTE=&lt;host&gt;:&lt;port&gt; and
              ARCHDUCTOR_ARCHCAR_TOKEN=&lt;token&gt;. MCP clients run `archductor mcp serve`.
            </div>
          </>
        )}
      </Show>
      <Show when={feedback()}>
        <div class="settings-status">{feedback()}</div>
      </Show>
    </div>
  );
}

export function SettingsPage() {
  const [repo, setRepo] = createSignal<string | undefined>(undefined);
  const [layer, setLayer] = createSignal<Layer>("repository");
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus | null>(null);
  const [checkingUpdates, setCheckingUpdates] = createSignal(false);
  const [recoveryStatus, setRecoveryStatus] = createSignal("Recovery has not run in this window.");
  const [recovering, setRecovering] = createSignal(false);

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

  const [promptPacks, { refetch: refetchPacks, mutate: mutatePacks }] = createResource(
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

  async function switchPack(pack: string) {
    const repository = repo();
    if (!repository) return;
    try {
      const res = await send({ type: "set_active_prompt_pack", repository, pack });
      if (res.type === "prompt_packs") {
        mutatePacks({ packs: res.packs, active: res.active });
        await refetchEffective();
      } else {
        await refetchPacks();
      }
    } catch {
      await refetchPacks();
    }
  }

  const [draft, setDraft] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal("");
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
    setStatus("Saving...");
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

  async function runUpdateCheck() {
    if (checkingUpdates()) return;
    setCheckingUpdates(true);
    try {
      const result = await checkForUpdates();
      setUpdateStatus(
        result.ok
          ? {
              currentVersion: result.currentVersion,
              latestVersion: result.latestVersion,
              updateAvailable: result.updateAvailable,
              releaseUrl: result.releaseUrl,
            }
          : { currentVersion: result.currentVersion, error: result.error },
      );
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function runRecoveryCheck() {
    if (recovering()) return;
    setRecovering(true);
    try {
      const res = await send({ type: "recover_workspace_lifecycle_jobs" });
      if (res.type === "workspace_lifecycle_recovery") {
        const total = res.recovered + res.reconciled_processes;
        setRecoveryStatus(
          total === 0
            ? "No pending workspace lifecycle jobs or stale script processes needed recovery."
            : `Recovered ${res.recovered} lifecycle job${res.recovered === 1 ? "" : "s"} and reconciled ${res.reconciled_processes} stale script process${res.reconciled_processes === 1 ? "" : "es"}.`,
        );
      } else if (res.type === "error") {
        setRecoveryStatus(`Recovery failed: ${res.message}`);
      }
    } catch (err) {
      setRecoveryStatus(`Recovery failed: ${(err as Error).message}`);
    } finally {
      setRecovering(false);
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
        <div class="settings-health-grid">
          <SetupReadinessCard />
          <div class="settings-field settings-health-card">
            <div class="settings-field-title">Updates</div>
            <div class="settings-status">
              {updateStatus() ? updateStatusText(updateStatus()!) : "Check GitHub releases for a newer build."}
            </div>
            <div class="settings-action-row">
              <button class="ui-button-secondary" disabled={checkingUpdates()} onClick={() => void runUpdateCheck()}>
                {checkingUpdates() ? "Checking..." : "Check for updates"}
              </button>
              <Show when={updateStatus()?.releaseUrl}>
                {(url) => (
                  <button class="ui-button-secondary" onClick={() => void openExternal(url())}>
                    Open release
                  </button>
                )}
              </Show>
            </div>
          </div>
          <BackgroundServiceCard />
          <div class="settings-field settings-health-card">
            <div class="settings-field-title">Recovery</div>
            <div class="settings-status">{recoveryStatus()}</div>
            <div class="settings-action-row">
              <button class="ui-button-secondary" disabled={recovering()} onClick={() => void runRecoveryCheck()}>
                {recovering() ? "Checking..." : "Run recovery check"}
              </button>
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
                  <button
                    class="settings-pack-chip"
                    classList={{ "settings-pack-chip-active": promptPacks()?.active === pack }}
                    disabled={promptPacks()?.active === pack}
                    title={promptPacks()?.active === pack ? "Active pack" : `Switch to ${pack}`}
                    onClick={() => void switchPack(pack)}
                  >
                    {pack}
                    <Show when={promptPacks()?.active === pack}> ✓</Show>
                  </button>
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
            <Show when={!effective.loading} fallback={<div class="empty-state">Loading...</div>}>
              <pre class="ws-diff-text">{effective()}</pre>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
