import {  Show,  createResource, createSignal } from "solid-js";
import {   send } from "@/bridge/client";
import type { ServiceStatus } from "@/bridge/protocol";

// Background service pane: install, start, and inspect the archcar service.
// Background service + remote access. The daemon has to be running for the app,
// the CLI, and MCP clients to work, so the OS should keep it up; and a
// token-guarded TCP listener is what lets a client on another machine reach it.
export function BackgroundServiceCard() {
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
        input: { listen: listen().trim() || undefined }
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
