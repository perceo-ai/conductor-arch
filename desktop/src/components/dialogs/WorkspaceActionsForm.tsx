import { createSignal, createResource, Show,  For } from "solid-js";
import {
  actions,
  workspacesStore
} from "@/store";
import {
  send
} from "@/bridge/client";
import { providersStore } from "@/store/providers";
import {  useSubmit } from "./DialogShared";

// Global modal host. Renders the form for the active dialog spec. Every form
// calls into `actions.*`, which logs the action, sends the archcar request, and
// re-pulls the inventory on success.

// The "More actions…" escape hatch: branch operations, linked directories, and\n// per-workspace provider defaults.
export function WorkspaceActionsForm(props: { workspace: string; onDone: () => void }) {
  const row = () => workspacesStore.row(props.workspace);
  const [newName, setNewName] = createSignal(props.workspace);
  const [dupName, setDupName] = createSignal(`${props.workspace}-copy`);
  const [branch, setBranch] = createSignal("");
  const [target, setTarget] = createSignal("");
  const [provider, setProvider] = createSignal("codex");
  const [links, { refetch: refetchLinks }] = createResource(
    () => props.workspace,
    async (ws): Promise<{ target_workspace: string; link_path: string }[]> => {
      try {
        const res = await send({ type: "list_linked_directories", workspace: ws });
        return res.type === "linked_directories" ? res.directories : [];
      } catch {
        return [];
      }
    },
  );
  // The lifecycle actions here don't close the dialog on their own; the caller
  // stays open so several tweaks can be chained. Rename/delete change selection.
  const { busy, error, submit } = useSubmit<() => Promise<unknown>>((run) => run(), () => {});

  return (
    <div class="dialog-form">
      <div class="dialog-action-section">
        <div class="dialog-section-head">
          <span class="dialog-section-title">Lifecycle</span>
          <span class="dialog-section-copy">Rename, duplicate, archive, or restore this workspace.</span>
        </div>
        <label class="dialog-field"><span>Rename to</span>
          <input value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} /></label>
        <div class="dialog-actions">
          <button class="ui-button" disabled={busy()} onClick={() => submit(() => actions.renameWorkspace(props.workspace, newName().trim()).then(props.onDone))}>Rename</button>
        </div>
        <label class="dialog-field"><span>Duplicate as</span>
          <input value={dupName()} onInput={(e) => setDupName(e.currentTarget.value)} /></label>
        <div class="dialog-actions">
          <button class="ui-button" disabled={busy()} onClick={() => submit(() => actions.duplicateWorkspace(props.workspace, dupName().trim()).then(props.onDone))}>Duplicate</button>
          <Show
            when={row()?.status === "archived"}
            fallback={
              <button class="ui-button" disabled={busy()} onClick={() => submit(() => actions.archiveWorkspace(props.workspace))}>Archive</button>
            }
          >
            <button class="ui-button" disabled={busy()} onClick={() => submit(() => actions.restoreWorkspace(props.workspace))}>Restore</button>
          </Show>
        </div>
      </div>

      <div class="dialog-action-section">
        <div class="dialog-section-head">
          <span class="dialog-section-title">Branch</span>
          <span class="dialog-section-copy">Create, switch, rename, or delete the workspace branch.</span>
        </div>
        <label class="dialog-field"><span>Branch</span>
          <input value={branch()} onInput={(e) => setBranch(e.currentTarget.value)} placeholder="branch name" /></label>
        <div class="dialog-actions dialog-actions-wrap">
          <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.createBranch(props.workspace, branch().trim()))}>Create</button>
          <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.checkoutBranch(props.workspace, branch().trim()))}>Checkout</button>
          <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.renameBranch(props.workspace, branch().trim()))}>Rename branch</button>
          <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.deleteBranch(props.workspace, branch().trim()))}>Delete branch</button>
        </div>
      </div>

      <div class="dialog-action-section">
        <div class="dialog-section-head">
          <span class="dialog-section-title">Linked directories</span>
          <span class="dialog-section-copy">Expose another workspace under this workspace's context links.</span>
        </div>
        <label class="dialog-field"><span>Link directory from workspace</span>
          <input value={target()} onInput={(e) => setTarget(e.currentTarget.value)} placeholder="target workspace name" /></label>
        <div class="dialog-actions dialog-actions-wrap">
          <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.linkWorkspaceDirectory(props.workspace, target().trim()).then(() => refetchLinks()))}>Link</button>
          <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.unlinkWorkspaceDirectory(props.workspace, target().trim()).then(() => refetchLinks()))}>Unlink</button>
        </div>
      </div>
      <Show when={(links() ?? []).length > 0}>
        <div class="dialog-linked-list">
          <For each={links()}>
            {(d) => (
              <div class="dialog-linked-row">
                <span class="dialog-linked-target">{d.target_workspace}</span>
                <span class="dialog-linked-path">{d.link_path}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div class="dialog-action-section">
        <div class="dialog-section-head">
          <span class="dialog-section-title">Default agent</span>
          <span class="dialog-section-copy">Choose the provider used when this workspace opens a new chat.</span>
        </div>
        <div class="dialog-provider-grid">
          <For each={providersStore.launchable()}>
            {(entry) => (
              <button
                class="dialog-provider-chip"
                classList={{
                  "dialog-provider-chip-active": provider() === entry.provider_key
                }}
                title={
                  providersStore.tierBadge(entry.provider_key)
                    ? `${entry.display_name} runs with reduced capabilities`
                    : entry.display_name
                }
                onClick={() => setProvider(entry.provider_key)}
              >
                {entry.display_name}
                <Show when={providersStore.tierBadge(entry.provider_key)}>
                  {(badge) => <span class="dialog-provider-chip-badge">{badge()}</span>}
                </Show>
              </button>
            )}
          </For>
        </div>
        <div class="dialog-actions">
          <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.setDefaultAgentProvider(props.workspace, provider().trim()))}>Set default</button>
        </div>
      </div>

      <div class="dialog-action-section dialog-danger-section">
        <div class="dialog-section-head">
          <span class="dialog-section-title">Danger zone</span>
          <span class="dialog-section-copy">Remove this workspace row and its worktree from disk.</span>
        </div>
        <div class="dialog-actions dialog-actions-wrap">
        <button class="ui-button-destructive" disabled={busy()} onClick={() => submit(() => actions.deleteWorkspace(props.workspace, true, false).then(props.onDone))}>
          Delete (remove worktree)
        </button>
        </div>
      </div>
      <Show when={error()}>{(msg) => <div class="dialog-error">{msg()}</div>}</Show>
    </div>
  );
}
