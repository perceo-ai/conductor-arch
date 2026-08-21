import { For, Show, createEffect, createMemo, createResource, createSignal, onMount, type JSX } from "solid-js";
import { repositoriesStore, prefsStore, nav, clientsStore, dialogs } from "@/store";
import { ACCENT_HEX } from "@/store/prefs";
import { checkForUpdates, openExternal, send } from "@/bridge/client";
import { MODELS, CHAT_PROVIDERS, modelLabel, providerLabel } from "@/lib/models";
import { DEFAULT_SHORTCUTS, parseKeybindingOverrides } from "@/lib/shortcuts";
import { updateStatusText, type UpdateStatus } from "@/lib/update";
import { SetupReadinessCard } from "@/components/SetupReadiness";
import Icon, { type IconName } from "@/components/Icon";
import type { ServiceStatus } from "@/bridge/protocol";

// Settings page — two panes per scope:
//   Effective : the merged, read-only config (get_settings) for reference.
//   Source    : the raw editable TOML for one layer (get_settings_source),
//               saved back through save_settings (validated server-side).
// Global scope edits the app-shared layer; a repository scope edits either its
// committed ("repository") or "local" override layer.

type Layer = "repository" | "local";
type SettingsSection = "general" | "clients" | "agents" | "repository" | "advanced";
type TomlValueKind = "string" | "number" | "bool";

function shortcutBindingKey(index: number): string {
  const binding = DEFAULT_SHORTCUTS[index];
  return binding.aliases?.[0] ?? binding.action;
}

function serializeShortcutBindings(bindings: typeof DEFAULT_SHORTCUTS): string {
  return bindings
    .map((binding, index) => ({ binding, index }))
    .filter(({ binding }) => binding.keys.trim())
    .map(({ binding, index }) => `${shortcutBindingKey(index)}=${binding.keys.trim()}`)
    .join("; ");
}

function setShortcutBinding(index: number, keys: string) {
  const current = parseKeybindingOverrides(prefsStore.state.keybindings, DEFAULT_SHORTCUTS);
  current[index] = { ...current[index], keys };
  prefsStore.setKeybindings(serializeShortcutBindings(current));
}

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  group: string;
  icon: IconName;
}> = [
  { id: "general", label: "General", group: "Personal", icon: "settings" },
  { id: "clients", label: "Clients", group: "Archcars", icon: "panel-right" },
  { id: "agents", label: "Agents", group: "Agents & environment", icon: "brain" },
  { id: "repository", label: "Repository behavior", group: "Repositories", icon: "folder" },
  { id: "advanced", label: "Advanced", group: "More", icon: "wrench" },
];

function SettingsNavButton(props: {
  active: boolean;
  icon: IconName;
  label: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <button class="settings-nav-button" classList={{ active: props.active }} onClick={props.onClick}>
      <Icon name={props.icon} class="settings-nav-icon" />
      <span class="settings-nav-text">
        <span class="settings-nav-label">{props.label}</span>
        <Show when={props.detail}>
          <span class="settings-nav-detail">{props.detail}</span>
        </Show>
      </span>
    </button>
  );
}

function SettingsSectionBlock(props: { title: string; children: JSX.Element }) {
  return (
    <section class="settings-section-block">
      <h2>{props.title}</h2>
      <div class="settings-section-list">{props.children}</div>
    </section>
  );
}

function SettingsRow(props: {
  title: string;
  description?: JSX.Element;
  meta?: JSX.Element;
  control?: JSX.Element;
  accent?: boolean;
}) {
  return (
    <div class="settings-row" classList={{ "settings-row-accent": props.accent }}>
      <div class="settings-row-copy">
        <div class="settings-row-title">{props.title}</div>
        <Show when={props.description}>
          <div class="settings-row-description">{props.description}</div>
        </Show>
        <Show when={props.meta}>
          <div class="settings-row-meta">{props.meta}</div>
        </Show>
      </div>
      <Show when={props.control}>
        <div class="settings-row-control">{props.control}</div>
      </Show>
    </div>
  );
}

function tomlSectionBounds(lines: string[], section: string): [number, number] | null {
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return [start, end];
}

function readTomlValue(toml: string, section: string, key: string): string {
  const lines = toml.split("\n");
  const bounds = tomlSectionBounds(lines, section);
  if (!bounds) return "";
  const [, end] = bounds;
  for (let index = bounds[0] + 1; index < end; index += 1) {
    const match = lines[index].match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (!match) continue;
    const raw = match[1].trim();
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw.slice(1, -1);
      }
    }
    return raw;
  }
  return "";
}

function formatTomlValue(value: string, kind: TomlValueKind): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (kind === "bool") return trimmed === "true" ? "true" : trimmed === "false" ? "false" : null;
  if (kind === "number") return /^-?\d+$/.test(trimmed) ? trimmed : null;
  return JSON.stringify(value);
}

function writeTomlValue(toml: string, section: string, key: string, value: string, kind: TomlValueKind): string {
  const formatted = formatTomlValue(value, kind);
  const lines = toml.trimEnd().split("\n");
  if (lines.length === 1 && lines[0] === "") lines.length = 0;
  let bounds = tomlSectionBounds(lines, section);
  if (!bounds && formatted == null) return toml;
  if (!bounds) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`[${section}]`);
    bounds = [lines.length - 1, lines.length];
  }
  const [start, end] = bounds;
  const existing = lines.findIndex((line, index) => index > start && index < end && new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (formatted == null) {
    if (existing >= 0) lines.splice(existing, 1);
    return `${lines.join("\n").trimEnd()}\n`;
  }
  const next = `${key} = ${formatted}`;
  if (existing >= 0) {
    lines[existing] = next;
  } else {
    lines.splice(end, 0, next);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function SettingsTextInput(props: {
  value: string;
  placeholder?: string;
  onInput: (value: string) => void;
}) {
  return (
    <input
      class="settings-control"
      value={props.value}
      placeholder={props.placeholder}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  );
}

function SettingsBoolSelect(props: { value: string; onInput: (value: string) => void }) {
  return (
    <select class="settings-control settings-boolean-control" value={props.value} onChange={(e) => props.onInput(e.currentTarget.value)}>
      <option value="">Inherit</option>
      <option value="true">On</option>
      <option value="false">Off</option>
    </select>
  );
}

// Skills and MCP servers live in each agent's own config on the daemon's
// machine, which drifts the moment you install something in one of them.
function SkillsCard() {
  const [skills, { refetch }] = createResource(async () => {
    try {
      const res = await send({ type: "list_skills" });
      return res.type === "skills" ? res.skills : [];
    } catch {
      return [];
    }
  });
  const [plan] = createResource(async () => {
    try {
      const res = await send({ type: "get_sync_plan", selection: {} });
      return res.type === "sync_plan" ? res.plan : null;
    } catch {
      return null;
    }
  });

  const pending = () => plan()?.actions.length ?? 0;

  return (
    <div class="settings-field settings-health-card">
      <div class="settings-field-title">Skills</div>
      <div class="settings-status">
        {skills()?.length ?? 0} skill{(skills()?.length ?? 0) === 1 ? "" : "s"} installed across
        this machine's agents. Type <code>/</code> in a chat to use one.
      </div>
      <div class="settings-status settings-hint">
        <Show when={pending() > 0} fallback="Every agent is in sync.">
          {pending()} change{pending() === 1 ? "" : "s"} would bring every agent into sync.
        </Show>
      </div>
      <div class="settings-action-row">
        <button
          class="ui-button-secondary"
          onClick={() => dialogs.open({ kind: "sync-skills" })}
        >
          Sync across agents…
        </button>
        <button class="ui-button-secondary" onClick={() => void refetch()}>
          Refresh
        </button>
      </div>
    </div>
  );
}

// Server-hosted execution: the daemons this machine can point at. One is
// active and owns the workspaces/sessions you see; the app is a pure client of
// it. The same selection moves this machine's CLI, because both read the
// profile that `saveClients` mirrors. Day-to-day switching happens in the
// sidebar; this card is where the list is managed.
function RemoteDaemonCard() {
  const [address, setAddress] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [token, setToken] = createSignal("");
  const [feedback, setFeedback] = createSignal("");

  onMount(() => void clientsStore.refresh());

  const busy = () => clientsStore.state.busy;

  async function add() {
    const addr = address().trim();
    const tok = token().trim();
    if (!addr || !tok) {
      setFeedback("Address and token are required.");
      return;
    }
    setFeedback("Connecting…");
    const ok = await clientsStore.add({
      label: label().trim() || undefined,
      address: addr,
      token: tok,
    });
    if (ok) {
      setAddress("");
      setLabel("");
      setToken("");
      setFeedback(`Connected to ${addr}.`);
    } else {
      setFeedback("Could not reach that daemon. Check the address and token.");
    }
  }

  const rename = (id: string, current: string) =>
    dialogs.open({
      kind: "confirm",
      title: `Rename ${current}`,
      message: "Give this client a new name.",
      confirmLabel: "Rename",
      input: { label: "Name", initialValue: current },
      onConfirm: (value) => {
        if (value && value !== current) void clientsStore.rename(id, value);
      },
    });

  const remove = (id: string, current: string) =>
    dialogs.open({
      kind: "confirm",
      title: `Forget ${current}?`,
      message: "The daemon keeps running; this machine just stops remembering how to reach it.",
      confirmLabel: "Forget",
      destructive: true,
      onConfirm: () => void clientsStore.remove(id),
    });

  return (
    <div class="settings-field settings-health-card">
      <div class="settings-field-title">Clients</div>
      <Show
        when={!clientsStore.pinned()}
        fallback={
          <div class="settings-status">
            ARCHDUCTOR_ARCHCAR_REMOTE pins this machine to {clientsStore.state.envAddress}; unset it
            to manage saved clients here.
          </div>
        }
      >
        <div class="settings-status">
          Switch between these anywhere with the picker above the sidebar.
        </div>

        <div class="client-rows">
          <div class="client-row" classList={{ active: clientsStore.state.activeId === null }}>
            <Icon name="monitor" class="client-row-icon" />
            <span class="client-row-text">
              <span class="client-row-label">This machine</span>
              <span class="client-row-address">local daemon</span>
            </span>
            <Show
              when={clientsStore.state.activeId !== null}
              fallback={<span class="client-row-active">Active</span>}
            >
              <button
                class="ui-button-secondary"
                disabled={busy()}
                onClick={() => void clientsStore.activate(null)}
              >
                Use
              </button>
            </Show>
          </div>
          <For each={clientsStore.state.clients}>
            {(client) => (
              <div
                class="client-row"
                classList={{ active: clientsStore.state.activeId === client.id }}
              >
                <Icon name="cloud" class="client-row-icon" />
                <span class="client-row-text">
                  <span class="client-row-label">{client.label}</span>
                  <span class="client-row-address">{client.address}</span>
                </span>
                <Show
                  when={clientsStore.state.activeId !== client.id}
                  fallback={<span class="client-row-active">Active</span>}
                >
                  <button
                    class="ui-button-secondary"
                    disabled={busy()}
                    onClick={() => void clientsStore.activate(client.id)}
                  >
                    Use
                  </button>
                </Show>
                <button
                  class="ui-button-secondary"
                  disabled={busy()}
                  onClick={() => rename(client.id, client.label)}
                >
                  Rename
                </button>
                <button
                  class="ui-button-secondary"
                  disabled={busy()}
                  onClick={() => remove(client.id, client.label)}
                >
                  Forget
                </button>
              </div>
            )}
          </For>
        </div>

        <div class="settings-action-row">
          <input
            class="ws-text-input"
            placeholder="name (optional)"
            value={label()}
            onInput={(e) => setLabel(e.currentTarget.value)}
          />
          <input
            class="ws-text-input"
            placeholder="host:port (e.g. devbox:7420)"
            value={address()}
            onInput={(e) => setAddress(e.currentTarget.value)}
          />
          <input
            class="ws-text-input"
            type="password"
            placeholder="access token"
            value={token()}
            onInput={(e) => setToken(e.currentTarget.value)}
          />
          <button class="ui-button-secondary" disabled={busy()} onClick={() => void add()}>
            Add
          </button>
        </div>
        <div class="settings-status settings-hint">
          On the other machine: `archductor service install --listen 0.0.0.0:7420`, then
          `archductor service token` for the token. This machine's CLI follows the same
          selection (`archductor remote list`).
        </div>
        <Show when={feedback()}>
          <div class="settings-status">{feedback()}</div>
        </Show>
      </Show>
    </div>
  );
}

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
  const [activeSection, setActiveSection] = createSignal<SettingsSection>("general");
  const [query, setQuery] = createSignal("");
  const [repo, setRepo] = createSignal<string | undefined>(undefined);
  const [layer, setLayer] = createSignal<Layer>("repository");
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus | null>(null);
  const [checkingUpdates, setCheckingUpdates] = createSignal(false);
  const [recoveryStatus, setRecoveryStatus] = createSignal("Recovery has not run in this window.");
  const [recovering, setRecovering] = createSignal(false);
  const filteredSections = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return SETTINGS_SECTIONS;
    return SETTINGS_SECTIONS.filter(
      (section) =>
        section.label.toLowerCase().includes(needle) ||
        section.group.toLowerCase().includes(needle),
    );
  });
  const groupedSections = createMemo(() => {
    const groups: Array<{ group: string; sections: typeof SETTINGS_SECTIONS }> = [];
    for (const section of filteredSections()) {
      let group = groups.find((entry) => entry.group === section.group);
      if (!group) {
        group = { group: section.group, sections: [] };
        groups.push(group);
      }
      group.sections.push(section);
    }
    return groups;
  });

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
  const settingValue = (section: string, key: string) => readTomlValue(draft() ?? "", section, key);
  const setSettingValue = (section: string, key: string, value: string, kind: TomlValueKind = "string") => {
    setDraft((current) => writeTomlValue(current ?? "", section, key, value, kind));
    setStatus("");
  };

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
        await refetchSource();
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
    <div class="settings-page-shell">
      <aside class="settings-sidebar">
        {/* Settings is the leftmost column now, so on macOS (hiddenInset title
            bar) it inherits the traffic lights the workspace sidebar's chrome
            row used to sit under. Reserve that strip and let it drag. */}
        <Show when={navigator.userAgent.includes("Mac")}>
          <div class="settings-titlebar-spacer drag-region" />
        </Show>
        {/* The only way out now that Settings replaces the sidebar, so it must
            never be dead: with no history to pop, fall back to the dashboard. */}
        <button
          class="settings-back-row"
          onClick={() => (nav.canBack() ? nav.back() : nav.goToPage("dashboard"))}
        >
          <Icon name="arrow-left" class="settings-back-icon" />
          <span>Settings</span>
        </button>
        <label class="settings-search">
          <Icon name="file" class="settings-search-icon" />
          <input
            value={query()}
            placeholder="Search settings"
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
        <div class="settings-nav-groups">
          <For each={groupedSections()}>
            {(group) => (
              <div class="settings-nav-group">
                <div class="settings-nav-group-title">{group.group}</div>
                <For each={group.sections}>
                  {(section) => (
                    <SettingsNavButton
                      active={activeSection() === section.id}
                      icon={section.icon}
                      label={section.label}
                      onClick={() => setActiveSection(section.id)}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
          <Show when={repositoriesStore.state.order.length > 0}>
            <div class="settings-nav-group">
              <div class="settings-nav-group-title">Repo Overrides</div>
              <For each={repositoriesStore.state.order}>
                {(name) => (
                  <SettingsNavButton
                    active={activeSection() === "repository" && repo() === name}
                    icon="folder"
                    label={name}
                    detail="Prompts, runs, behavior"
                    onClick={() => {
                      setRepo(name);
                      setActiveSection("repository");
                    }}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
      </aside>

      <main class="settings-main">
        <Show when={activeSection() === "general"}>
          <div class="settings-content-narrow">
            <h1>General</h1>
            <SettingsSectionBlock title="Personal">
              <SettingsRow
                title="Default model for new chats"
                description="Choose the model selected when a new chat thread starts."
                control={
                  <select
                    id="default-model"
                    class="settings-control"
                    value={prefsStore.state.defaultModel}
                    onChange={(e) => prefsStore.setDefaultModel(e.currentTarget.value)}
                  >
                    <For each={CHAT_PROVIDERS}>
                      {(provider) => (
                        <optgroup label={providerLabel(provider)}>
                          <For each={MODELS[provider] ?? []}>
                            {(m) => <option value={m}>{modelLabel(m)}</option>}
                          </For>
                        </optgroup>
                      )}
                    </For>
                  </select>
                }
              />
              <SettingsRow
                title="Theme"
                description="Choose the desktop appearance."
                control={
                  <div class="settings-segmented">
                    <For each={["dark", "light"] as const}>
                      {(t) => (
                        <button
                          classList={{ active: prefsStore.state.theme === t }}
                          onClick={() => prefsStore.setTheme(t)}
                        >
                          {t === "dark" ? "Dark" : "Light"}
                        </button>
                      )}
                    </For>
                  </div>
                }
              />
              <SettingsRow
                title="Accent"
                description="Used for selected tabs, rows, and primary affordances."
                control={
                  <div class="settings-swatch-row">
                    <For each={["amber", "blue", "green", "rose"] as const}>
                      {(a) => (
                        <button
                          class="settings-swatch"
                          classList={{ active: prefsStore.state.accent === a }}
                          style={{ "--swatch": ACCENT_HEX[a] }}
                          title={a}
                          onClick={() => prefsStore.setAccent(a)}
                        />
                      )}
                    </For>
                  </div>
                }
              />
              <SettingsRow
                title="Density"
                description="Adjust spacing across workspace lists and controls."
                control={
                  <div class="settings-segmented">
                    <For each={["compact", "cozy", "comfortable"] as const}>
                      {(d) => (
                        <button
                          classList={{ active: prefsStore.state.density === d }}
                          onClick={() => prefsStore.setDensity(d)}
                        >
                          {d[0].toUpperCase() + d.slice(1)}
                        </button>
                      )}
                    </For>
                  </div>
                }
              />
            </SettingsSectionBlock>
            <SettingsSectionBlock title="Keyboard">
              <For each={parseKeybindingOverrides(prefsStore.state.keybindings, DEFAULT_SHORTCUTS)}>
                {(binding, index) => (
                  <SettingsRow
                    title={binding.label}
                    description={shortcutBindingKey(index())}
                    control={
                      <input
                        class="settings-control settings-shortcut-input"
                        value={binding.keys}
                        placeholder="mod+k"
                        spellcheck={false}
                        onInput={(e) => setShortcutBinding(index(), e.currentTarget.value)}
                      />
                    }
                  />
                )}
              </For>
            </SettingsSectionBlock>
          </div>
        </Show>

        <Show when={activeSection() === "clients"}>
          <div class="settings-content-narrow">
            <h1>Clients</h1>
            <SettingsSectionBlock title="This Device">
              <RemoteDaemonCard />
            </SettingsSectionBlock>
            <SettingsSectionBlock title="Host Access">
              <BackgroundServiceCard />
              <SettingsRow
                title="Multiple clients"
                description="Hosted web, Perceo mobile, CLI, and MCP clients can all connect to the same listening archcar."
                meta="Use one host:port plus the current token per client. Rotating the token revokes existing clients."
                accent
              />
            </SettingsSectionBlock>
          </div>
        </Show>

        <Show when={activeSection() === "agents"}>
          <div class="settings-content-narrow">
            <h1>Agents</h1>
            <SettingsSectionBlock title="Environment">
              <SetupReadinessCard />
            </SettingsSectionBlock>
            <SettingsSectionBlock title="Skills and MCP">
              <SkillsCard />
            </SettingsSectionBlock>
            <SettingsSectionBlock title="Maintenance">
              <SettingsRow
                title="Recovery"
                description={recoveryStatus()}
                control={
                  <button class="ui-button-secondary" disabled={recovering()} onClick={() => void runRecoveryCheck()}>
                    {recovering() ? "Checking..." : "Run recovery check"}
                  </button>
                }
              />
            </SettingsSectionBlock>
          </div>
        </Show>

        <Show when={activeSection() === "repository"}>
          <div class="settings-content-wide">
            <h1>{repo() === undefined ? "Repository Behavior" : repo()}</h1>
            <SettingsSectionBlock title="Repositories">
              <button
                class="settings-repo-row"
                classList={{ active: repo() === undefined }}
                onClick={() => setRepo(undefined)}
              >
                <span>
                  <strong>Global defaults</strong>
                  <small>Fallback prompts, runs, workspace defaults, and behavior</small>
                </span>
                <Icon name="chevron-right" class="settings-nav-icon" />
              </button>
              <For each={repositoriesStore.state.order}>
                {(name) => {
                  const row = () => repositoriesStore.row(name);
                  return (
                    <button
                      class="settings-repo-row"
                      classList={{ active: repo() === name }}
                      onClick={() => setRepo(name)}
                    >
                      <span>
                        <strong>{name}</strong>
                        <small>
                          {row()?.activeWorkspaces ?? 0} active / {row()?.totalWorkspaces ?? 0} total workspaces
                        </small>
                      </span>
                      <Icon name="chevron-right" class="settings-nav-icon" />
                    </button>
                  );
                }}
              </For>
            </SettingsSectionBlock>
            <Show when={repo() !== undefined}>
              <div class="settings-top-controls">
                <div class="settings-segmented">
                  <button classList={{ active: layer() === "repository" }} onClick={() => setLayer("repository")}>
                    Repository
                  </button>
                  <button classList={{ active: layer() === "local" }} onClick={() => setLayer("local")}>
                    Local
                  </button>
                </div>
              </div>
            </Show>
            <Show when={repo() !== undefined && (promptPacks()?.packs.length ?? 0) > 0}>
              <SettingsSectionBlock title="Prompt Packs">
                <SettingsRow
                  title="Active prompt pack"
                  description="Switch the committed prompt set for this repository."
                  control={
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
                  }
                />
              </SettingsSectionBlock>
            </Show>
            <SettingsSectionBlock title="Prompts">
              <SettingsRow
                title="General instructions"
                description="Prepended to the first managed chat turn."
                control={
                  <SettingsTextInput
                    value={settingValue("prompts", "general")}
                    placeholder="Prefer small, reviewable changes..."
                    onInput={(value) => setSettingValue("prompts", "general", value)}
                  />
                }
              />
              <SettingsRow
                title="New workspace"
                description="Used when creating a workspace from free-form instructions."
                control={
                  <SettingsTextInput
                    value={settingValue("prompts", "new_workspace")}
                    placeholder="Create a small workspace plan..."
                    onInput={(value) => setSettingValue("prompts", "new_workspace", value)}
                  />
                }
              />
              <SettingsRow
                title="Continue work"
                description="Used when asking an agent to pick up existing work."
                control={
                  <SettingsTextInput
                    value={settingValue("prompts", "continue_work")}
                    onInput={(value) => setSettingValue("prompts", "continue_work", value)}
                  />
                }
              />
              <SettingsRow
                title="Code review"
                description="Used for review staging and review-focused agent work."
                control={
                  <SettingsTextInput
                    value={settingValue("prompts", "code_review")}
                    onInput={(value) => setSettingValue("prompts", "code_review", value)}
                  />
                }
              />
            </SettingsSectionBlock>
            <SettingsSectionBlock title="Runs And Checks">
              <SettingsRow
                title="Setup command"
                description="Command run when preparing a workspace."
                control={
                  <SettingsTextInput
                    value={settingValue("scripts", "setup")}
                    placeholder="pnpm install"
                    onInput={(value) => setSettingValue("scripts", "setup", value)}
                  />
                }
              />
              <SettingsRow
                title="Run command"
                description="Default local run command."
                control={
                  <SettingsTextInput
                    value={settingValue("scripts", "run")}
                    placeholder="pnpm dev"
                    onInput={(value) => setSettingValue("scripts", "run", value)}
                  />
                }
              />
              <SettingsRow
                title="Run mode"
                description="Whether run commands can execute concurrently."
                control={
                  <select
                    class="settings-control"
                    value={settingValue("scripts", "run_mode")}
                    onChange={(e) => setSettingValue("scripts", "run_mode", e.currentTarget.value)}
                  >
                    <option value="">Inherit</option>
                    <option value="concurrent">Concurrent</option>
                    <option value="nonconcurrent">Nonconcurrent</option>
                  </select>
                }
              />
              <SettingsRow
                title="Test command"
                control={
                  <SettingsTextInput
                    value={settingValue("scripts", "test")}
                    placeholder="cargo test"
                    onInput={(value) => setSettingValue("scripts", "test", value)}
                  />
                }
              />
              <SettingsRow
                title="Lint command"
                control={
                  <SettingsTextInput
                    value={settingValue("scripts", "lint")}
                    onInput={(value) => setSettingValue("scripts", "lint", value)}
                  />
                }
              />
              <SettingsRow
                title="Typecheck command"
                control={
                  <SettingsTextInput
                    value={settingValue("scripts", "typecheck")}
                    onInput={(value) => setSettingValue("scripts", "typecheck", value)}
                  />
                }
              />
              <SettingsRow
                title="Build command"
                control={
                  <SettingsTextInput
                    value={settingValue("scripts", "build")}
                    onInput={(value) => setSettingValue("scripts", "build", value)}
                  />
                }
              />
            </SettingsSectionBlock>
            <SettingsSectionBlock title="Workspace Defaults">
              <SettingsRow
                title="Base branch"
                control={
                  <SettingsTextInput
                    value={settingValue("customization.workspace_defaults", "base_branch")}
                    placeholder="main"
                    onInput={(value) => setSettingValue("customization.workspace_defaults", "base_branch", value)}
                  />
                }
              />
              <SettingsRow
                title="Branch prefix"
                control={
                  <SettingsTextInput
                    value={settingValue("customization.workspace_defaults", "branch_prefix")}
                    placeholder="lc"
                    onInput={(value) => setSettingValue("customization.workspace_defaults", "branch_prefix", value)}
                  />
                }
              />
              <SettingsRow
                title="Workspace parent"
                description="Override where new worktrees are created."
                control={
                  <SettingsTextInput
                    value={settingValue("customization.workspace_defaults", "workspace_parent")}
                    placeholder="/path/to/workspaces"
                    onInput={(value) => setSettingValue("customization.workspace_defaults", "workspace_parent", value)}
                  />
                }
              />
              <SettingsRow
                title="Port block size"
                control={
                  <SettingsTextInput
                    value={settingValue("customization.workspace_defaults", "port_block_size")}
                    placeholder="10"
                    onInput={(value) => setSettingValue("customization.workspace_defaults", "port_block_size", value, "number")}
                  />
                }
              />
              <SettingsRow
                title="Default visible tab"
                control={
                  <select
                    class="settings-control"
                    value={settingValue("customization.workspace_defaults", "default_visible_tab")}
                    onChange={(e) =>
                      setSettingValue("customization.workspace_defaults", "default_visible_tab", e.currentTarget.value)
                    }
                  >
                    <option value="">Inherit</option>
                    <option value="changes">Changes</option>
                    <option value="files">Files</option>
                    <option value="intel">Intel</option>
                    <option value="terminal">Terminal</option>
                  </select>
                }
              />
            </SettingsSectionBlock>
            <SettingsSectionBlock title="Git Behavior">
              <SettingsRow
                title="Delete branch on archive"
                control={
                  <SettingsBoolSelect
                    value={settingValue("git", "delete_branch_on_archive")}
                    onInput={(value) => setSettingValue("git", "delete_branch_on_archive", value, "bool")}
                  />
                }
              />
              <SettingsRow
                title="Archive after merge"
                control={
                  <SettingsBoolSelect
                    value={settingValue("git", "archive_on_merge")}
                    onInput={(value) => setSettingValue("git", "archive_on_merge", value, "bool")}
                  />
                }
              />
              <SettingsRow
                title="Auto setup push remote"
                control={
                  <SettingsBoolSelect
                    value={settingValue("git", "worktree_push_auto_setup_remote")}
                    onInput={(value) => setSettingValue("git", "worktree_push_auto_setup_remote", value, "bool")}
                  />
                }
              />
            </SettingsSectionBlock>
            <SettingsSectionBlock title="Changes">
              <SettingsRow
                title={repo() === undefined ? "Global defaults" : `${layer()} overrides`}
                description="Save the individual settings above."
                meta={status() || (dirty() ? "Unsaved changes" : "Saved")}
                control={
                  <button class="suggested-action" disabled={!dirty()} onClick={() => void save()}>
                    Save
                  </button>
                }
                accent={dirty()}
              />
            </SettingsSectionBlock>
          </div>
        </Show>

        <Show when={activeSection() === "advanced"}>
          <div class="settings-content-narrow">
            <h1>Advanced</h1>
            <SettingsSectionBlock title="Updates">
              <SettingsRow
                title="App updates"
                description={updateStatus() ? updateStatusText(updateStatus()!) : "Check GitHub releases for a newer build."}
                control={
                  <div class="settings-action-row">
                    <button
                      class="ui-button-secondary"
                      disabled={checkingUpdates()}
                      onClick={() => void runUpdateCheck()}
                    >
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
                }
              />
            </SettingsSectionBlock>
          </div>
        </Show>
      </main>
    </div>
  );
}
