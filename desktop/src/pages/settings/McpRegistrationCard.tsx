import { For, Show, createResource, createSignal } from "solid-js";
import { send } from "@/bridge/client";
import type { McpClientRegistration } from "@/bridge/protocol";

// Archductor's own MCP server, offered to the agent CLIs on this device.
//
// Registration goes through each client's own `mcp add`, so the entry lands in
// that client's configuration and shows up in its own listings next to every
// other MCP server. Nothing here is hidden from the agent or from the user: it
// can be disabled from this card, or from claude/codex directly.
export function McpRegistrationCard() {
  const [clients, { refetch }] = createResource(async (): Promise<McpClientRegistration[]> => {
    try {
      const res = await send({ type: "get_mcp_registration" });
      return res.type === "mcp_registration" ? res.clients : [];
    } catch {
      return [];
    }
  });
  const [busy, setBusy] = createSignal(false);
  const [feedback, setFeedback] = createSignal("");

  const anyInstalled = () => (clients() ?? []).some((client) => client.installed);
  const anyRegistered = () => (clients() ?? []).some((client) => client.registered);

  function stateText(client: McpClientRegistration): string {
    if (!client.installed) return "not installed";
    return client.registered ? "registered" : "not registered";
  }

  async function run(label: string, register: boolean) {
    if (busy()) return;
    setBusy(true);
    setFeedback(`${label}…`);
    try {
      const res = await send({ type: "set_mcp_registration", register });
      if (res.type === "error") {
        setFeedback(res.message);
      } else {
        const failures = (res.type === "mcp_registration" ? res.clients : [])
          .filter((client) => client.installed && client.detail && client.registered !== register)
          .map((client) => `${client.client}: ${client.detail}`);
        setFeedback(failures.join(" · "));
      }
      await refetch();
    } catch (err) {
      setFeedback(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="settings-field settings-health-card">
      <div class="settings-field-title">Archductor MCP server</div>
      <div class="settings-status">
        Lets agents keep this workspace's summary, names, and tasks current from inside a session.
      </div>
      <Show
        when={anyInstalled()}
        fallback={<div class="settings-status">No supported agent CLI found on this machine.</div>}
      >
        <For each={clients() ?? []}>
          {(client) => (
            <div class="settings-status">
              {client.client}: {stateText(client)}
            </div>
          )}
        </For>
        <div class="settings-action-row">
          <button class="ui-button-secondary" disabled={busy()} onClick={() => void run("Registering", true)}>
            {anyRegistered() ? "Re-register" : "Register"}
          </button>
          <Show when={anyRegistered()}>
            <button class="ui-button-secondary" disabled={busy()} onClick={() => void run("Removing", false)}>
              Remove
            </button>
          </Show>
        </div>
      </Show>
      <Show when={feedback()}>
        <div class="settings-status">{feedback()}</div>
      </Show>
    </div>
  );
}
