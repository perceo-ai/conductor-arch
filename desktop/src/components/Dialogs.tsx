import { createSignal, Show, Switch, Match, For } from "solid-js";
import { actions, dialogs, workspacesStore } from "@/store";

// Global modal host. Renders the form for the active dialog spec. Every form
// calls into `actions.*`, which logs the action, sends the archcar request, and
// re-pulls the inventory on success.

function Modal(props: { title: string; onClose: () => void; children: any }) {
  return (
    <div class="modal-scrim" onClick={props.onClose}>
      <div class="modal-body dialog-card" onClick={(e) => e.stopPropagation()}>
        <div class="dialog-header">
          <span class="dialog-title">{props.title}</span>
          <button class="ui-button-icon" title="Close" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

function useSubmit<T>(run: (v: T) => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const submit = async (v: T) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await run(v);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function AddProjectForm(props: { onDone: () => void }) {
  const [mode, setMode] = createSignal<"local" | "clone">("local");
  const [path, setPath] = createSignal("");
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [dest, setDest] = createSignal("");
  const { busy, error, submit } = useSubmit<void>(async () => {
    if (mode() === "local") {
      if (!path().trim()) throw new Error("Repository path is required");
      await actions.addRepository({ path: path().trim(), name: name().trim() || undefined });
    } else {
      if (!url().trim() || !dest().trim()) throw new Error("Clone URL and destination are required");
      await actions.cloneRepository({ url: url().trim(), dest: dest().trim(), name: name().trim() || undefined });
    }
  }, props.onDone);

  return (
    <div class="dialog-form">
      <div class="dialog-tabs">
        <button class="ui-button-sm" classList={{ active: mode() === "local" }} onClick={() => setMode("local")}>
          Local path
        </button>
        <button class="ui-button-sm" classList={{ active: mode() === "clone" }} onClick={() => setMode("clone")}>
          Clone URL
        </button>
      </div>
      <Show when={mode() === "local"} fallback={
        <>
          <label class="dialog-field">
            <span>Git URL</span>
            <input value={url()} onInput={(e) => setUrl(e.currentTarget.value)} placeholder="git@github.com:org/repo.git" />
          </label>
          <label class="dialog-field">
            <span>Destination directory</span>
            <input value={dest()} onInput={(e) => setDest(e.currentTarget.value)} placeholder="/home/you/code/repo" />
          </label>
        </>
      }>
        <label class="dialog-field">
          <span>Repository path</span>
          <input value={path()} onInput={(e) => setPath(e.currentTarget.value)} placeholder="/home/you/code/repo" />
        </label>
      </Show>
      <label class="dialog-field">
        <span>Name (optional)</span>
        <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="derived from folder" />
      </label>
      <Show when={error()}>{(msg) => <div class="dialog-error">{msg()}</div>}</Show>
      <div class="dialog-actions">
        <button class="ui-button" onClick={props.onDone}>Cancel</button>
        <button class="ui-button-primary" disabled={busy()} onClick={() => submit()}>
          {busy() ? "Working…" : mode() === "local" ? "Add project" : "Clone & add"}
        </button>
      </div>
    </div>
  );
}

function CreateWorkspaceForm(props: { repository: string; onDone: () => void }) {
  type Source = "branch" | "prompt" | "issue" | "pr";
  const [source, setSource] = createSignal<Source>("branch");
  const [name, setName] = createSignal("");
  const [branch, setBranch] = createSignal("");
  const [base, setBase] = createSignal("");
  const [prompt, setPrompt] = createSignal("");
  const [issue, setIssue] = createSignal("");
  const [pr, setPr] = createSignal("");
  const { busy, error, submit } = useSubmit<void>(async () => {
    const repository = props.repository;
    const baseRef = base().trim() || undefined;
    if (source() === "branch") {
      if (!name().trim() || !branch().trim()) throw new Error("Name and branch are required");
      await actions.createWorkspace({ repository, name: name().trim(), branch: branch().trim(), baseRef });
    } else if (source() === "prompt") {
      if (!prompt().trim()) throw new Error("Prompt is required");
      await actions.createWorkspaceFromPrompt({
        repository,
        prompt: prompt().trim(),
        name: name().trim() || undefined,
        branch: branch().trim() || undefined,
        baseRef,
      });
    } else if (source() === "issue") {
      const n = Number(issue().trim());
      if (!Number.isInteger(n) || n <= 0) throw new Error("Enter a valid issue number");
      await actions.createWorkspaceFromIssue({ repository, issueNumber: n });
    } else {
      const n = Number(pr().trim());
      if (!Number.isInteger(n) || n <= 0) throw new Error("Enter a valid PR number");
      await actions.createWorkspaceFromPullRequest({ repository, prNumber: n, name: name().trim() || undefined, branch: branch().trim() || undefined });
    }
  }, props.onDone);

  const sources: { key: Source; label: string }[] = [
    { key: "branch", label: "Branch" },
    { key: "prompt", label: "Prompt" },
    { key: "issue", label: "GitHub issue" },
    { key: "pr", label: "GitHub PR" },
  ];

  return (
    <div class="dialog-form">
      <div class="dialog-tabs">
        <For each={sources}>
          {(s) => (
            <button class="ui-button-sm" classList={{ active: source() === s.key }} onClick={() => setSource(s.key)}>
              {s.label}
            </button>
          )}
        </For>
      </div>

      <Switch>
        <Match when={source() === "branch"}>
          <label class="dialog-field"><span>Workspace name</span>
            <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="my-feature" /></label>
          <label class="dialog-field"><span>Branch</span>
            <input value={branch()} onInput={(e) => setBranch(e.currentTarget.value)} placeholder="feature/x" /></label>
          <label class="dialog-field"><span>Base ref (optional)</span>
            <input value={base()} onInput={(e) => setBase(e.currentTarget.value)} placeholder="default branch" /></label>
        </Match>
        <Match when={source() === "prompt"}>
          <label class="dialog-field"><span>Prompt</span>
            <textarea rows={3} value={prompt()} onInput={(e) => setPrompt(e.currentTarget.value)} placeholder="Describe the task…" /></label>
          <label class="dialog-field"><span>Name (optional)</span>
            <input value={name()} onInput={(e) => setName(e.currentTarget.value)} /></label>
          <label class="dialog-field"><span>Base ref (optional)</span>
            <input value={base()} onInput={(e) => setBase(e.currentTarget.value)} /></label>
        </Match>
        <Match when={source() === "issue"}>
          <label class="dialog-field"><span>Issue number</span>
            <input value={issue()} onInput={(e) => setIssue(e.currentTarget.value)} placeholder="123" /></label>
        </Match>
        <Match when={source() === "pr"}>
          <label class="dialog-field"><span>PR number</span>
            <input value={pr()} onInput={(e) => setPr(e.currentTarget.value)} placeholder="456" /></label>
          <label class="dialog-field"><span>Name (optional)</span>
            <input value={name()} onInput={(e) => setName(e.currentTarget.value)} /></label>
        </Match>
      </Switch>

      <Show when={error()}>{(msg) => <div class="dialog-error">{msg()}</div>}</Show>
      <div class="dialog-actions">
        <button class="ui-button" onClick={props.onDone}>Cancel</button>
        <button class="ui-button-primary" disabled={busy()} onClick={() => submit()}>
          {busy() ? "Creating…" : "Create workspace"}
        </button>
      </div>
    </div>
  );
}

function WorkspaceActionsForm(props: { workspace: string; onDone: () => void }) {
  const row = () => workspacesStore.row(props.workspace);
  const [newName, setNewName] = createSignal(props.workspace);
  const [dupName, setDupName] = createSignal(`${props.workspace}-copy`);
  const [branch, setBranch] = createSignal("");
  const [target, setTarget] = createSignal("");
  const [provider, setProvider] = createSignal("");
  // The lifecycle actions here don't close the dialog on their own; the caller
  // stays open so several tweaks can be chained. Rename/delete change selection.
  const { busy, error, submit } = useSubmit<() => Promise<unknown>>((run) => run(), () => {});

  return (
    <div class="dialog-form">
      <label class="dialog-field"><span>Rename to</span>
        <input value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} /></label>
      <div class="dialog-actions">
        <button class="ui-button" disabled={busy()} onClick={() => submit(() => actions.renameWorkspace(props.workspace, newName().trim()).then(props.onDone))}>Rename</button>
      </div>

      <label class="dialog-field"><span>Duplicate as</span>
        <input value={dupName()} onInput={(e) => setDupName(e.currentTarget.value)} /></label>
      <div class="dialog-actions">
        <button class="ui-button" disabled={busy()} onClick={() => submit(() => actions.duplicateWorkspace(props.workspace, dupName().trim()).then(props.onDone))}>Duplicate</button>
      </div>

      <div class="dialog-divider" />

      <label class="dialog-field"><span>Branch</span>
        <input value={branch()} onInput={(e) => setBranch(e.currentTarget.value)} placeholder="branch name" /></label>
      <div class="dialog-actions dialog-actions-wrap">
        <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.createBranch(props.workspace, branch().trim()))}>Create</button>
        <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.checkoutBranch(props.workspace, branch().trim()))}>Checkout</button>
        <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.renameBranch(props.workspace, branch().trim()))}>Rename branch</button>
        <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.deleteBranch(props.workspace, branch().trim()))}>Delete branch</button>
      </div>

      <div class="dialog-divider" />

      <label class="dialog-field"><span>Link directory from workspace</span>
        <input value={target()} onInput={(e) => setTarget(e.currentTarget.value)} placeholder="target workspace name" /></label>
      <div class="dialog-actions dialog-actions-wrap">
        <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.linkWorkspaceDirectory(props.workspace, target().trim()))}>Link</button>
        <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.unlinkWorkspaceDirectory(props.workspace, target().trim()))}>Unlink</button>
      </div>

      <label class="dialog-field"><span>Default agent provider</span>
        <input value={provider()} onInput={(e) => setProvider(e.currentTarget.value)} placeholder="codex | claude | cursor" /></label>
      <div class="dialog-actions">
        <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.setDefaultAgentProvider(props.workspace, provider().trim()))}>Set default</button>
      </div>

      <div class="dialog-divider" />

      <div class="dialog-actions dialog-actions-wrap">
        <Show
          when={row()?.status === "archived"}
          fallback={
            <button class="ui-button" disabled={busy()} onClick={() => submit(() => actions.archiveWorkspace(props.workspace))}>Archive</button>
          }
        >
          <button class="ui-button" disabled={busy()} onClick={() => submit(() => actions.restoreWorkspace(props.workspace))}>Restore</button>
        </Show>
        <button class="ui-button-destructive" disabled={busy()} onClick={() => submit(() => actions.deleteWorkspace(props.workspace, true, false).then(props.onDone))}>
          Delete (remove worktree)
        </button>
      </div>
      <Show when={error()}>{(msg) => <div class="dialog-error">{msg()}</div>}</Show>
    </div>
  );
}

export default function Dialogs() {
  const spec = dialogs.current;
  const close = () => dialogs.close();
  return (
    <Show when={spec()}>
      {(s) => (
        <Switch>
          <Match when={s().kind === "add-project"}>
            <Modal title="Add project" onClose={close}>
              <AddProjectForm onDone={close} />
            </Modal>
          </Match>
          <Match when={s().kind === "create-workspace"}>
            <Modal title="New workspace" onClose={close}>
              <CreateWorkspaceForm repository={(s() as { repository: string }).repository} onDone={close} />
            </Modal>
          </Match>
          <Match when={s().kind === "workspace-actions"}>
            <Modal title={`Workspace: ${(s() as { workspace: string }).workspace}`} onClose={close}>
              <WorkspaceActionsForm workspace={(s() as { workspace: string }).workspace} onDone={close} />
            </Modal>
          </Match>
        </Switch>
      )}
    </Show>
  );
}
