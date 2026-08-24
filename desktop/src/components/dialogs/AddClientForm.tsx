import { createSignal,  Show } from "solid-js";
import {
  clientsStore
} from "@/store";

// Global modal host. Renders the form for the active dialog spec. Every form
// calls into `actions.*`, which logs the action, sends the archcar request, and
// re-pulls the inventory on success.

// Register another archcar daemon this app can switch between.
// Save another daemon and switch to it. Main verifies the address/token before
// committing, so a typo fails here instead of leaving the app pointed at
// nothing.
export function AddClientForm(props: { onDone: () => void }) {
  const [label, setLabel] = createSignal("");
  const [address, setAddress] = createSignal("");
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const submit = async () => {
    const addr = address().trim();
    const tok = token().trim();
    if (!addr || !tok) {
      setError("Address and token are required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const ok = await clientsStore.add({
        label: label().trim() || undefined,
        address: addr,
        token: tok
      });
      if (ok) props.onDone();
      else setError("Could not reach that daemon. Check the address and token.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="dialog-form">
      <label class="dialog-field">
        <span>Name (optional)</span>
        <input value={label()} onInput={(e) => setLabel(e.currentTarget.value)} placeholder="Devbox" />
      </label>
      <label class="dialog-field">
        <span>Address</span>
        <input
          value={address()}
          onInput={(e) => setAddress(e.currentTarget.value)}
          placeholder="devbox:7420"
        />
      </label>
      <label class="dialog-field">
        <span>Access token</span>
        <input
          type="password"
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
          placeholder="from `archductor service token` on that machine"
        />
      </label>
      <div class="dialog-hint">
        On that machine: <code>archductor service install --listen 0.0.0.0:7420</code>, then
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
