import { createResource, createSignal, For, Show } from "solid-js";

import { send } from "@/bridge/client";
import { clientsStore, toastsStore } from "@/store";
import type { SyncPlan, SyncSelection } from "@/bridge/protocol";
import Icon from "./Icon";

// One button that makes every agent on the daemon's machine agree about skills
// and MCP servers, with a matrix for narrowing what gets written.
//
// The plan is fetched before anything is applied and rendered verbatim, because
// this writes into ~/.claude, ~/.codex and ~/.cursor — files the user did not
// hand us. Nothing is deleted and replaced files are backed up, but the preview
// is what makes that legible rather than a promise in a tooltip.

function rowLabel(kind: string): string {
  return kind === "skill" ? "Skill" : "MCP server";
}

export default function SyncSkillsDialog(props: { onDone: () => void }) {
  const [excludedItems, setExcludedItems] = createSignal<Set<string>>(new Set());
  const [excludedProviders, setExcludedProviders] = createSignal<Set<string>>(new Set());
  const [busy, setBusy] = createSignal(false);

  // Two resources on purpose. The inventory is fetched once with an empty
  // selection so it always lists everything; the preview is keyed on the
  // exclusions. Deriving the selection from the preview's own result would
  // make the resource depend on itself and it would never settle.
  const [inventory] = createResource(async (): Promise<SyncPlan | null> => {
    try {
      const res = await send({ type: "get_sync_plan", selection: {} });
      return res.type === "sync_plan" ? res.plan : null;
    } catch {
      return null;
    }
  });

  const selection = (): SyncSelection => {
    const plan = inventory();
    if (!plan) return {};
    return {
      skills: Object.keys(plan.skills).filter((n) => !excludedItems().has(`skill:${n}`)),
      mcp_servers: Object.keys(plan.mcp_servers).filter((n) => !excludedItems().has(`mcp:${n}`)),
      providers: plan.providers.filter((p) => !excludedProviders().has(p)),
    };
  };

  const [planResource, { refetch }] = createResource(
    () => (inventory() ? { items: excludedItems(), providers: excludedProviders() } : null),
    async (): Promise<SyncPlan | null> => {
      try {
        const res = await send({ type: "get_sync_plan", selection: selection() });
        return res.type === "sync_plan" ? res.plan : null;
      } catch {
        return null;
      }
    },
  );

  const toggle = (setter: typeof setExcludedItems, key: string) =>
    setter((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  async function apply() {
    setBusy(true);
    try {
      const res = await send({ type: "apply_sync", selection: selection() });
      if (res.type === "sync_applied") {
        toastsStore.push(
          res.applied.length === 0
            ? "Everything was already in sync."
            : `Synced ${res.applied.length} item${res.applied.length === 1 ? "" : "s"}.`,
        );
        props.onDone();
      } else {
        toastsStore.error("Sync failed.");
      }
    } catch (err) {
      toastsStore.error(`Sync failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      await refetch();
    }
  }

  const itemRows = () => {
    const plan = inventory();
    if (!plan) return [];
    return [
      ...Object.entries(plan.skills).map(([name, providers]) => ({
        kind: "skill",
        name,
        providers,
      })),
      ...Object.entries(plan.mcp_servers).map(([name, providers]) => ({
        kind: "mcp",
        name,
        providers,
      })),
    ];
  };

  return (
    <div class="dialog-form sync-dialog">
      <div class="dialog-hint">
        Writes to the agent config on{" "}
        <strong>
          {clientsStore.state.activeId === null
            ? "this machine"
            : clientsStore.activeLabel()}
        </strong>
        . Nothing is deleted; replaced files are backed up alongside the original.
      </div>

      <Show when={planResource()} fallback={<div class="dialog-hint">Reading providers…</div>}>
        {(plan) => (
          <>
            <div class="sync-providers">
              <span class="sync-providers-label">Sync into</span>
              <For each={inventory()?.providers ?? []}>
                {(provider) => (
                  <label class="sync-provider-toggle">
                    <input
                      type="checkbox"
                      checked={!excludedProviders().has(provider)}
                      onChange={() => toggle(setExcludedProviders, provider)}
                    />
                    <span>{provider}</span>
                  </label>
                )}
              </For>
            </div>

            <div class="sync-rows">
              <For each={itemRows()}>
                {(row) => {
                  const key = `${row.kind}:${row.name}`;
                  // Only the providers that can actually hold this kind:
                  // Cursor takes MCP servers but has no skills directory.
                  const targets = () => {
                    const plan = inventory();
                    if (!plan) return [];
                    const list =
                      row.kind === "skill"
                        ? (plan.skill_providers ?? plan.providers)
                        : (plan.mcp_providers ?? plan.providers);
                    return list;
                  };
                  const missing = () =>
                    targets().filter(
                      (p) => !row.providers.includes(p) && !excludedProviders().has(p),
                    );
                  return (
                    <label class="sync-row" classList={{ "sync-row-excluded": excludedItems().has(key) }}>
                      <input
                        type="checkbox"
                        checked={!excludedItems().has(key)}
                        onChange={() => toggle(setExcludedItems, key)}
                      />
                      <span class="sync-row-kind">{rowLabel(row.kind)}</span>
                      <span class="sync-row-name">{row.name}</span>
                      <span class="sync-row-state">
                        <Show when={missing().length > 0} fallback={<span class="sync-row-ok">in sync</span>}>
                          adds to {missing().join(", ")}
                        </Show>
                      </span>
                    </label>
                  );
                }}
              </For>
            </div>

            <div class="sync-preview">
              <Show
                when={plan().actions.length > 0}
                fallback={<span class="sync-row-ok">Nothing to write — every provider already matches.</span>}
              >
                <For each={plan().actions}>
                  {(action) => (
                    <div class="sync-preview-line">
                      <Icon name="arrow-right" class="sync-preview-icon" />
                      <span>
                        {action.item} → {action.provider}
                      </span>
                      <span class="sync-preview-target">{action.target}</span>
                      <Show when={action.overwrite}>
                        <span class="sync-preview-overwrite">overwrite</span>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>

            <div class="dialog-actions">
              <button class="ui-button" onClick={props.onDone}>
                Cancel
              </button>
              <button
                class="ui-button-primary"
                disabled={busy() || plan().actions.length === 0}
                onClick={() => void apply()}
              >
                {busy()
                  ? "Syncing…"
                  : `Sync ${plan().actions.length} change${plan().actions.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
