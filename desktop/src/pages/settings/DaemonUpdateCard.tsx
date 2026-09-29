import { Show, createResource, createSignal } from "solid-js";
import { actions, clientsStore } from "@/store";
import { daemonUpdateSummary } from "@/lib/daemonUpdate";

// The connected daemon's version and how to move it forward. It follows the
// client switcher, so updating a server is: pick it, press the button — the
// daemon downloads and restarts itself, no SSH session. The CLI equivalent is
// `archductor remote update <client>`.
export function DaemonUpdateCard() {
  // Keyed on the selected client: switching daemons with Settings open must
  // not leave one daemon's version above a button that updates another.
  const [status, { refetch, mutate }] = createResource(() => clientsStore.activeLabel(), async () => {
    try {
      return await actions.daemonUpdateStatus();
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = createSignal(false);
  const [feedback, setFeedback] = createSignal("");
  const summary = () => {
    const current = status();
    return current ? daemonUpdateSummary(current) : null;
  };

  async function run(label: string, action: () => Promise<string>) {
    if (busy()) return;
    setBusy(true);
    setFeedback(`${label}…`);
    try {
      setFeedback(await action());
      await refetch();
    } catch (err) {
      setFeedback(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const apply = (force = false) =>
    run("Updating daemon", async () => {
      const target = clientsStore.activeLabel();
      const update = await actions.updateDaemon({
        force,
        stillTargeted: () => clientsStore.activeLabel() === target,
      });
      return `Now running v${update.to_version} (was v${update.from_version}).`;
    });

  const toggleAuto = (enabled: boolean) =>
    run(enabled ? "Turning on automatic updates" : "Turning off automatic updates", async () => {
      mutate(await actions.setDaemonAutoUpdate(enabled));
      return enabled
        ? "The daemon now updates itself when a release is out and no agent is mid-turn."
        : "Automatic updates are off.";
    });

  const busyAgents = () => feedback().includes("mid-turn");

  return (
    <div class="settings-field settings-health-card">
      <div class="settings-field-title">Daemon · {clientsStore.activeLabel()}</div>
      <Show
        when={summary()}
        fallback={
          <div class="settings-status">
            This daemon predates remote updates. Install the new release on it by hand once and
            restart its service; after that it can be updated from here.
          </div>
        }
      >
        {(current) => (
          <>
            <div class="settings-status">{current().headline}</div>
            <Show when={current().guidance}>
              {(guidance) => <div class="settings-status">{guidance()}</div>}
            </Show>
            <div class="settings-action-row">
              <Show when={current().action}>
                {(action) => (
                  <button class="ui-button-primary" disabled={busy()} onClick={() => void apply()}>
                    {action().label}
                  </button>
                )}
              </Show>
              <Show when={busyAgents()}>
                <button class="ui-button-secondary" disabled={busy()} onClick={() => void apply(true)}>
                  Update anyway (stops running agents)
                </button>
              </Show>
              <Show when={status()?.channel !== "development"}>
                <label class="dialog-check">
                  <input
                    type="checkbox"
                    checked={status()?.auto_update ?? false}
                    disabled={busy()}
                    onChange={(e) => void toggleAuto(e.currentTarget.checked)}
                  />
                  Update automatically when idle
                </label>
              </Show>
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
