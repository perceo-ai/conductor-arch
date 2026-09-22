import { Show, createResource, createSignal } from "solid-js";
import { sendLocal } from "@/bridge/client";
import { pairingReadiness } from "./pairingReadiness";

// Pairing a phone with this daemon.
//
// This lived at the bottom of the clients card, below the saved-daemon list it
// has nothing to do with, and only reported a problem after the button failed.
// It is its own card now, and it states up front whether this daemon is even
// reachable from a phone.
export function PairPhoneCard() {
  // Deliberately the local route, not the selected daemon: `pairing:qr` builds
  // the code from this machine's own daemon, so asking a remote daemon whether
  // it is ready would answer a question about the wrong computer.
  const [access, { refetch }] = createResource(async () => {
    try {
      const res = await sendLocal({ type: "get_remote_access" });
      return res.type === "remote_access" ? { listen: res.listen, token: res.token } : null;
    } catch {
      return null;
    }
  });
  // What remote access was configured to serve, which outlives any one daemon.
  const [configured, { refetch: refetchConfigured }] = createResource(async () => {
    try {
      const res = await sendLocal({ type: "get_service_status" });
      return res.type === "service_status" ? (res.status.listen ?? null) : null;
    } catch {
      return null;
    }
  });
  const [shownAddress, setShownAddress] = createSignal("");
  const [error, setError] = createSignal("");

  const readiness = () => pairingReadiness(access() ?? null, configured());

  // Main opens the code in its own isolated window; the code encodes the
  // daemon token, so this process only ever learns the address.
  async function showPairingCode() {
    setError("");
    setShownAddress("");
    const result = await window.archductor.pairingQr();
    if (result.ok) setShownAddress(result.address);
    else setError(result.error);
  }

  return (
    <div class="settings-field settings-health-card">
      <div class="settings-field-title">Pair a phone</div>
      <div class="settings-status">
        Scan this code with Archductor for iOS to point it at this machine.
      </div>
      <Show
        when={readiness().ready}
        fallback={
          <Show when={!access.loading && !configured.loading}>
            {(() => {
              const state = readiness() as { ready: false; reason: string; fix?: string };
              return (
                <>
                  <div class="settings-status">{state.reason}</div>
                  <Show when={state.fix}>
                    <div class="settings-status settings-hint">{state.fix}</div>
                  </Show>
                  <div class="settings-action-row">
                    <button
                      class="ui-button-secondary"
                      onClick={() => {
                        void refetch();
                        void refetchConfigured();
                      }}
                    >
                      Check again
                    </button>
                  </div>
                </>
              );
            })()}
          </Show>
        }
      >
        <div class="settings-action-row">
          <button class="ui-button-secondary" onClick={() => void showPairingCode()}>
            Show pairing code
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <div class="settings-status">{error()}</div>
      </Show>
      <Show when={shownAddress()}>
        <div class="settings-status settings-hint">
          The code for {shownAddress()} is open in its own window. Anyone who scans it gains full
          control of this machine, so close that window once the phone has paired;
          `archductor service token --rotate` revokes it.
        </div>
      </Show>
    </div>
  );
}
