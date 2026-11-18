import { createSignal, For, onMount, Show } from "solid-js";
import { clientsStore } from "@/store";

// Save another daemon and switch to it. Main verifies the address (and token,
// for TCP) before committing, so a typo fails here instead of leaving the app
// pointed at nothing. Daemons found on this machine's tailnet are listed above
// the form: an SSH one connects in a click, a TCP one fills the address in.
export function AddClientForm(props: { address?: string; label?: string; onDone: () => void }) {
  const [label, setLabel] = createSignal(props.label ?? "");
  const [address, setAddress] = createSignal(props.address ?? "");
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [scanning, setScanning] = createSignal(false);

  const isSsh = () => address().trim().startsWith("ssh://");

  const scan = async () => {
    setScanning(true);
    try {
      await clientsStore.discoverTailscale();
    } finally {
      setScanning(false);
    }
  };
  onMount(() => void scan());

  const submit = async () => {
    const addr = address().trim();
    const tok = token().trim();
    if (!addr) {
      setError("Address is required.");
      return;
    }
    if (!tok && !isSsh()) {
      setError("A host:port address needs the server's token. ssh:// addresses need none.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const ok = await clientsStore.add({
        label: label().trim() || undefined,
        address: addr,
        token: tok || undefined,
      });
      if (ok) props.onDone();
      else setError(isSsh() ? "Could not reach Archductor over SSH." : "Could not reach that daemon. Check the address and token.");
    } finally {
      setBusy(false);
    }
  };

  const useSuggestion = async (peer: (typeof clientsStore.state.suggestions)[number]) => {
    setError("");
    if (peer.needs_token) {
      setAddress(peer.suggested_address);
      setLabel(peer.host_name);
      return;
    }
    setBusy(true);
    try {
      if (await clientsStore.connectSuggestion(peer)) props.onDone();
      else setError(`Could not reach Archductor on ${peer.host_name} over SSH.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="dialog-form">
      <div class="dialog-field">
        <span>
          Found on your tailnet{" "}
          <button class="ui-button" disabled={scanning()} onClick={() => void scan()}>
            {scanning() ? "Scanning…" : "Rescan"}
          </button>
        </span>
        <Show
          when={clientsStore.state.suggestions.length > 0}
          fallback={
            <div class="dialog-hint">
              {scanning()
                ? "Looking for Archductor daemons on Tailscale…"
                : clientsStore.state.discoveryError ?? "No unsaved Archductor daemons found on Tailscale."}
            </div>
          }
        >
          <For each={clientsStore.state.suggestions}>
            {(peer) => (
              <div class="dialog-suggestion-row">
                <span>
                  <strong>{peer.host_name}</strong> <code>{peer.suggested_address}</code>
                  {peer.needs_token ? " · needs token" : " · Tailscale SSH"}
                </span>
                <button class="ui-button" disabled={busy()} onClick={() => void useSuggestion(peer)}>
                  {peer.needs_token ? "Use" : "Connect"}
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>
      <label class="dialog-field">
        <span>Name (optional)</span>
        <input value={label()} onInput={(e) => setLabel(e.currentTarget.value)} placeholder="Devbox" />
      </label>
      <label class="dialog-field">
        <span>Address</span>
        <input
          value={address()}
          onInput={(e) => setAddress(e.currentTarget.value)}
          placeholder="devbox:7420 or ssh://devbox"
        />
      </label>
      <Show when={!isSsh()}>
        <label class="dialog-field">
          <span>Access token</span>
          <input
            type="password"
            value={token()}
            onInput={(e) => setToken(e.currentTarget.value)}
            placeholder="from `archductor service token` on that machine"
          />
        </label>
      </Show>
      <div class="dialog-hint">
        Over Tailscale SSH (<code>tailscale set --ssh</code> on that machine) no token is needed. Otherwise
        run <code>archductor service install --listen 0.0.0.0:7420</code> there, then
        <code> archductor service token</code>.
      </div>
      <Show when={error()}>{(msg) => <div class="dialog-error">{msg()}</div>}</Show>
      <div class="dialog-actions">
        <button class="ui-button" onClick={props.onDone}>
          Cancel
        </button>
        <button class="ui-button-primary" disabled={busy()} onClick={() => void submit()}>
          {busy() ? "Connecting…" : "Add and switch"}
        </button>
      </div>
    </div>
  );
}
