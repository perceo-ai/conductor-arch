import { createSignal,  Show } from "solid-js";
import {
  actions
} from "@/store";
import {
  send
} from "@/bridge/client";

// Global modal host. Renders the form for the active dialog spec. Every form
// calls into `actions.*`, which logs the action, sends the archcar request, and
// re-pulls the inventory on success.

// Queue a background task against a repository.
// Start a background development task: archductor creates the workspace, runs
// the agent on the prompt, then prepares the review (checks, summary, and an
// optional pull request) without a human at the keyboard.
export function BackgroundTaskForm(props: { repository: string; onDone: () => void }) {
  const [prompt, setPrompt] = createSignal("");
  const [provider, setProvider] = createSignal("codex");
  const [extraAgents, setExtraAgents] = createSignal("");
  const [runChecks, setRunChecks] = createSignal(true);
  const [openPr, setOpenPr] = createSignal(false);
  const [draftPr, setDraftPr] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  async function start() {
    const text = prompt().trim();
    if (!text || busy()) return;
    setBusy(true);
    setError("");
    try {
      const res = await send({
        type: "start_background_task",
        input: {
          repository: props.repository,
          prompt: text,
          provider: provider(),
          run_checks: runChecks(),
          open_pr: openPr(),
          draft_pr: draftPr(),
          extra_agents: extraAgents()
            .split(",")
            .map((p) => p.trim().toLowerCase())
            .filter(Boolean)
            .map((p) => ({ provider: p }))
        }
      });
      if (res.type === "error") {
        setError(res.message);
        return;
      }
      await actions.refreshInventory();
      props.onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="dialog-form">
      <label class="dialog-field">
        <span class="dialog-label">Task for the agent</span>
        <textarea
          class="ws-text-input dialog-textarea"
          rows={5}
          placeholder="Describe the change. A workspace and branch are created for it."
          value={prompt()}
          onInput={(e) => setPrompt(e.currentTarget.value)}
        />
      </label>
      <label class="dialog-field">
        <span class="dialog-label">Agent</span>
        <select
          class="ws-text-input"
          value={provider()}
          onChange={(e) => setProvider(e.currentTarget.value)}
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </label>
      <label class="dialog-field">
        <span class="dialog-label">Extra agents (optional)</span>
        <input
          class="ws-text-input"
          placeholder="codex, claude — each runs its own session on the same prompt"
          value={extraAgents()}
          onInput={(e) => setExtraAgents(e.currentTarget.value)}
        />
      </label>
      <label class="dialog-check">
        <input
          type="checkbox"
          checked={runChecks()}
          onChange={(e) => setRunChecks(e.currentTarget.checked)}
        />
        Run configured checks when the agent finishes
      </label>
      <label class="dialog-check">
        <input
          type="checkbox"
          checked={openPr()}
          onChange={(e) => setOpenPr(e.currentTarget.checked)}
        />
        Commit, push, and open a pull request (uses local gh auth)
      </label>
      <Show when={openPr()}>
        <label class="dialog-check">
          <input
            type="checkbox"
            checked={draftPr()}
            onChange={(e) => setDraftPr(e.currentTarget.checked)}
          />
          Open it as a draft pull request
        </label>
      </Show>
      <Show when={error()}>
        <div class="dialog-error">{error()}</div>
      </Show>
      <div class="dialog-actions">
        <button class="ui-button" onClick={props.onDone}>
          Cancel
        </button>
        <button class="ui-button" disabled={!prompt().trim() || busy()} onClick={() => void start()}>
          {busy() ? "Starting…" : "Start in background"}
        </button>
      </div>
    </div>
  );
}
