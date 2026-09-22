import { For, Show,  createSignal, onMount } from "solid-js";
import {    clientsStore, dialogs } from "@/store";
import Icon, {  } from "@/components/Icon";

// Remote daemon pane: point this client at an archcar daemon on another host.
// Server-hosted execution: the daemons this machine can point at. One is
// active and owns the workspaces/sessions you see; the app is a pure client of
// it. The same selection moves this machine's CLI, because both read the
// profile that `saveClients` mirrors. Day-to-day switching happens in the
// sidebar; this card is where the list is managed.
export function RemoteDaemonCard() {
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
      token: tok
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
      }
    });

  const remove = (id: string, current: string) =>
    dialogs.open({
      kind: "confirm",
      title: `Forget ${current}?`,
      message: "The daemon keeps running; this machine just stops remembering how to reach it.",
      confirmLabel: "Forget",
      destructive: true,
      onConfirm: () => void clientsStore.remove(id)
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
