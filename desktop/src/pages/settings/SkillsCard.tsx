import {  Show,  createResource } from "solid-js";
import {     dialogs } from "@/store";
import {   send } from "@/bridge/client";

// Skills pane: what is installed, and syncing from the library.
// Skills and MCP servers live in each agent's own config on the daemon's
// machine, which drifts the moment you install something in one of them.
export function SkillsCard() {
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
