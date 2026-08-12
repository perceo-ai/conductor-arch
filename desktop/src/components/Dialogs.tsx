import { createSignal, createResource, Show, Switch, Match, For } from "solid-js";
import { actions, dialogs, workspacesStore, repositoriesStore, type ConfirmSpec } from "@/store";
import {
  selectFolder,
  listGithubRepos,
  listGithubWork,
  send,
  type GithubRepo,
  type GithubWorkItem,
} from "@/bridge/client";

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

/** Join a parent directory and a folder name into a destination path. */
function joinPath(parent: string, folder: string): string {
  if (!parent) return folder;
  return `${parent.replace(/\/+$/, "")}/${folder}`;
}

/** Compact "edited 3d ago" style label from an ISO timestamp. */
function relTime(iso: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  const units: [number, string][] = [
    [31536000, "y"],
    [2592000, "mo"],
    [604800, "w"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [size, label] of units) {
    if (secs >= size) return `${Math.floor(secs / size)}${label} ago`;
  }
  return "just now";
}

function AddProjectForm(props: { onDone: () => void }) {
  const [mode, setMode] = createSignal<"local" | "clone">("local");
  const [path, setPath] = createSignal("");
  const [name, setName] = createSignal("");
  // Clone tab: pick a gh repo, pick a parent dir; dest is derived from both.
  const [repoUrl, setRepoUrl] = createSignal("");
  const [repoName, setRepoName] = createSignal("");
  const [parentDir, setParentDir] = createSignal("");
  const [filter, setFilter] = createSignal("");

  // Lazily fetch the user's GitHub repos the first time the Clone tab is opened.
  type ReposResult = { ok: true; repos: GithubRepo[] } | { ok: false; error: string };
  const [repos, { refetch: refetchRepos }] = createResource<ReposResult, boolean>(
    () => mode() === "clone",
    () => listGithubRepos(),
  );

  const dest = () => (repoName() ? joinPath(parentDir(), repoName()) : "");

  const filteredRepos = (): GithubRepo[] => {
    const r = repos();
    if (!r?.ok) return [];
    const q = filter().trim().toLowerCase();
    return q ? r.repos.filter((repo) => repo.nameWithOwner.toLowerCase().includes(q)) : r.repos;
  };

  const pickFolder = async (setter: (v: string) => void, title: string) => {
    const picked = await selectFolder({ title, defaultPath: parentDir() || path() || undefined });
    if (picked) setter(picked);
  };

  const onSelectRepo = (repo: GithubRepo | undefined) => {
    if (!repo) {
      setRepoUrl("");
      setRepoName("");
      return;
    }
    setRepoUrl(repo.sshUrl);
    setRepoName(repo.name);
  };

  const { busy, error, submit } = useSubmit<void>(async () => {
    if (mode() === "local") {
      if (!path().trim()) throw new Error("Repository path is required");
      await actions.addRepository({ path: path().trim(), name: name().trim() || undefined });
    } else {
      if (!repoUrl().trim()) throw new Error("Select a repository to clone");
      if (!parentDir().trim()) throw new Error("Choose a destination folder");
      await actions.cloneRepository({ url: repoUrl().trim(), dest: dest(), name: name().trim() || undefined });
    }
  }, props.onDone);

  return (
    <div class="dialog-form">
      <div class="dialog-tabs">
        <button class="ui-button-sm" classList={{ active: mode() === "local" }} onClick={() => setMode("local")}>
          Local path
        </button>
        <button class="ui-button-sm" classList={{ active: mode() === "clone" }} onClick={() => setMode("clone")}>
          Clone from GitHub
        </button>
      </div>
      <Show when={mode() === "local"} fallback={
        <>
          <div class="dialog-field">
            <div class="dialog-field-head">
              <span>Repository</span>
              <button
                class="ui-button-icon"
                title="Reload"
                disabled={repos.loading}
                onClick={() => void refetchRepos()}
              >
                ⟳
              </button>
            </div>
            <Show
              when={repos()?.ok}
              fallback={
                <Show
                  when={repos.loading}
                  fallback={
                    <div class="dialog-error">
                      {repos()?.ok === false ? (repos() as { error: string }).error : "Could not load repos. Is gh installed & authed?"}
                    </div>
                  }
                >
                  <div class="dialog-hint">Loading repositories…</div>
                </Show>
              }
            >
              <input
                class="repo-search"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                placeholder="Search repositories…"
              />
              <div class="repo-picker">
                <For
                  each={filteredRepos()}
                  fallback={<div class="repo-empty">No matching repositories</div>}
                >
                  {(repo) => {
                    const selected = () => repoUrl() === repo.sshUrl;
                    return (
                      <button
                        type="button"
                        class="repo-card"
                        classList={{ selected: selected() }}
                        onClick={() => onSelectRepo(selected() ? undefined : repo)}
                      >
                        <img class="repo-card-avatar" src={repo.avatarUrl} alt="" loading="lazy" />
                        <div class="repo-card-text">
                          <span class="repo-card-title">{repo.name}</span>
                          <span class="repo-card-sub">{repo.owner} · edited {relTime(repo.pushedAt)}</span>
                        </div>
                        <span class="repo-card-action">{selected() ? "Selected" : "Select"}</span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
          <label class="dialog-field">
            <span>Destination folder</span>
            <div class="dialog-field-row">
              <input value={parentDir()} onInput={(e) => setParentDir(e.currentTarget.value)} placeholder="/home/you/code" />
              <button class="ui-button-sm" onClick={() => pickFolder(setParentDir, "Choose destination folder")}>Browse…</button>
            </div>
            <Show when={dest()}>
              <span class="dialog-hint">Clones into {dest()}</span>
            </Show>
          </label>
        </>
      }>
        <label class="dialog-field">
          <span>Repository path</span>
          <div class="dialog-field-row">
            <input value={path()} onInput={(e) => setPath(e.currentTarget.value)} placeholder="/home/you/code/repo" />
            <button class="ui-button-sm" onClick={() => pickFolder(setPath, "Select repository folder")}>Browse…</button>
          </div>
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
  // Two ways to start a workspace. Names + branches are always autogenerated
  // (linux/distro codenames) in core; the Prompt flow lets the agent rename via
  // <archductor_metadata> on the first message, the Github flow uses the
  // {prefix}/gh-{issue|pr}-{n} branch scheme.
  type Source = "prompt" | "branch" | "github" | "linear";
  const [source, setSource] = createSignal<Source>("prompt");
  const [prompt, setPrompt] = createSignal("");
  const [selected, setSelected] = createSignal<GithubWorkItem | null>(null);
  const [linearIssue, setLinearIssue] = createSignal("");
  const [filter, setFilter] = createSignal("");
  // Branch/base source (restores the GTK "create from branch/base" flow).
  const [wsName, setWsName] = createSignal("");
  const [wsBranch, setWsBranch] = createSignal("");
  const [wsBase, setWsBase] = createSignal("");
  // Available base branches, loaded when the Branch tab is opened.
  const [baseBranches] = createResource(
    () => (source() === "branch" ? props.repository : undefined),
    async (repository): Promise<string[]> => {
      try {
        const res = await send({ type: "list_repository_branches", repository });
        return res.type === "repository_branches" ? res.branches : [];
      } catch {
        return [];
      }
    },
  );

  const rootPath = () => repositoriesStore.row(props.repository)?.rootPath ?? "";

  // Lazily fetch open issues + PRs the first time the Github tab is opened.
  type WorkResult = { ok: true; items: GithubWorkItem[] } | { ok: false; error: string };
  const [work, { refetch: refetchWork }] = createResource<WorkResult, string>(
    () => (source() === "github" && rootPath() ? rootPath() : undefined),
    (path) => listGithubWork({ rootPath: path }),
  );

  const filteredWork = (): GithubWorkItem[] => {
    const r = work();
    if (!r?.ok) return [];
    const q = filter().trim().toLowerCase();
    if (!q) return r.items;
    return r.items.filter(
      (it) => it.title.toLowerCase().includes(q) || String(it.number).includes(q),
    );
  };

  const { busy, error, submit } = useSubmit<void>(async () => {
    const repository = props.repository;
    if (source() === "prompt") {
      // Prompt is optional — empty just creates an empty workspace.
      await actions.createWorkspaceFromPromptMessage({ repository, prompt: prompt().trim() });
    } else if (source() === "branch") {
      await actions.createWorkspace({
        repository,
        name: wsName().trim(),
        branch: wsBranch().trim(),
        baseRef: wsBase().trim() || undefined,
      });
    } else if (source() === "linear") {
      const issue = linearIssue().trim();
      if (!issue) throw new Error("Enter a Linear issue ID (e.g. ENG-123)");
      await actions.createWorkspaceFromLinear({ repository, issueId: issue });
    } else {
      const item = selected();
      if (!item) throw new Error("Select an issue or pull request");
      if (item.kind === "issue") {
        await actions.createWorkspaceFromIssue({ repository, issueNumber: item.number });
      } else {
        await actions.createWorkspaceFromPullRequest({ repository, prNumber: item.number });
      }
    }
  }, props.onDone);

  const sourceMeta: Record<Source, { label: string; detail: string }> = {
    prompt: {
      label: "Prompt",
      detail: "Start from a task brief and let the agent shape the workspace.",
    },
    branch: {
      label: "Branch",
      detail: "Create a named workspace from a base branch.",
    },
    github: {
      label: "GitHub",
      detail: "Start from an open issue or pull request using local gh auth.",
    },
    linear: {
      label: "Linear",
      detail: "Start from a Linear issue when LINEAR_API_KEY is available.",
    },
  };

  const sourceState = (key: Source) => {
    if (key === "github") {
      if (!rootPath()) return "No project path";
      if (work.loading) return "Loading";
      if (work()?.ok === false) return "Needs gh";
      return "Ready";
    }
    if (key === "linear") return "Needs key";
    return "Ready";
  };

  const missingRequirement = () => {
    if (source() === "github" && !selected()) return "Select a GitHub issue or pull request.";
    if (source() === "linear" && !linearIssue().trim()) return "Enter a Linear issue ID.";
    return "";
  };
  const canSubmit = () => !busy() && !missingRequirement();
  const previewRows = (): [string, string][] => {
    if (source() === "prompt") {
      return [
        ["Source", "Prompt"],
        ["Workspace", "Generated automatically"],
        ["First message", prompt().trim() ? "Prompt will be sent to the agent" : "No first message"],
      ];
    }
    if (source() === "branch") {
      return [
        ["Source", "Branch"],
        ["Workspace", wsName().trim() || "Generated automatically"],
        ["Branch", wsBranch().trim() || "Generated automatically"],
        ["Base", wsBase().trim() || "Repository default branch"],
      ];
    }
    if (source() === "linear") {
      return [
        ["Source", "Linear"],
        ["Issue", linearIssue().trim() || "Required"],
        ["Auth", "Requires LINEAR_API_KEY in archcar environment"],
      ];
    }
    const item = selected();
    return [
      ["Source", "GitHub"],
      ["Selection", item ? `${item.kind === "pr" ? "PR" : "Issue"} #${item.number}` : "Required"],
      ["Auth", "Uses local gh authentication"],
    ];
  };

  const submitLabel = () =>
    busy()
      ? "Creating..."
      : source() === "prompt"
        ? "Start workspace"
        : source() === "github"
          ? "Create from selection"
          : "Create workspace";

  const submitTitle = () => missingRequirement() || submitLabel();

  const sourceClass = (key: Source) => ({
    "dialog-source-active": source() === key,
    "dialog-source-warning": sourceState(key).startsWith("Needs"),
  });

  const sourceTone = (key: Source) =>
    sourceState(key) === "Ready" ? "dialog-source-state-ready" : "dialog-source-state-action";

  const sourceItems: { key: Source; label: string; detail: string }[] = [
    { key: "prompt", ...sourceMeta.prompt },
    { key: "branch", ...sourceMeta.branch },
    { key: "github", ...sourceMeta.github },
    { key: "linear", ...sourceMeta.linear },
  ];

  return (
    <div class="dialog-form">
      <div class="dialog-source-grid">
        <For each={sourceItems}>
          {(s) => (
            <button
              class="dialog-source-card"
              classList={sourceClass(s.key)}
              onClick={() => setSource(s.key)}
            >
              <span class="dialog-source-card-head">
                <span class="dialog-source-label">{s.label}</span>
                <span class={`dialog-source-state ${sourceTone(s.key)}`}>
                  {sourceState(s.key)}
                </span>
              </span>
              <span class="dialog-source-detail">{s.detail}</span>
            </button>
          )}
        </For>
      </div>

      <Switch>
        <Match when={source() === "prompt"}>
          <label class="dialog-field"><span>Prompt</span>
            <textarea
              rows={4}
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              placeholder="Describe the task… (optional — sent as the first message)"
            /></label>
          <span class="dialog-hint">Optional. Workspace + branch are named automatically; a prompt is sent as the first message and the agent renames from its reply.</span>
        </Match>
        <Match when={source() === "branch"}>
          <label class="dialog-field"><span>Workspace name</span>
            <input value={wsName()} onInput={(e) => setWsName(e.currentTarget.value)} placeholder="e.g. auth-refactor" /></label>
          <label class="dialog-field"><span>Branch name</span>
            <input value={wsBranch()} onInput={(e) => setWsBranch(e.currentTarget.value)} placeholder="e.g. lc/auth-refactor" /></label>
          <label class="dialog-field"><span>Base branch</span>
            <input
              value={wsBase()}
              onInput={(e) => setWsBase(e.currentTarget.value)}
              list="create-ws-base-branches"
              placeholder="Optional — defaults to the repo default branch"
            />
            <datalist id="create-ws-base-branches">
              <For each={baseBranches() ?? []}>{(b) => <option value={b} />}</For>
            </datalist>
          </label>
          <span class="dialog-hint">Creates a workspace on a new branch off the base. Leave name/branch blank to auto-generate.</span>
        </Match>
        <Match when={source() === "linear"}>
          <label class="dialog-field"><span>Linear issue ID</span>
            <input value={linearIssue()} onInput={(e) => setLinearIssue(e.currentTarget.value)} placeholder="e.g. ENG-123" /></label>
          <span class="dialog-hint">Creates a workspace from a Linear issue. Requires LINEAR_API_KEY in the daemon's environment.</span>
        </Match>
        <Match when={source() === "github"}>
          <div class="dialog-field">
            <div class="dialog-field-head">
              <span>Open issues &amp; pull requests</span>
              <button
                class="ui-button-icon"
                title="Reload"
                disabled={work.loading}
                onClick={() => void refetchWork()}
              >
                ⟳
              </button>
            </div>
            <Show
              when={work()?.ok}
              fallback={
                <Show
                  when={work.loading}
                  fallback={
                    <div class="dialog-error">
                      {work()?.ok === false ? (work() as { error: string }).error : "Could not load issues/PRs. Is gh installed & authed?"}
                    </div>
                  }
                >
                  <div class="dialog-hint">Loading issues &amp; PRs…</div>
                </Show>
              }
            >
              <input
                class="repo-search"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                placeholder="Search by title or number…"
              />
              <div class="repo-picker">
                <For each={filteredWork()} fallback={<div class="repo-empty">No open issues or PRs</div>}>
                  {(item) => {
                    const isSel = () =>
                      selected()?.kind === item.kind && selected()?.number === item.number;
                    return (
                      <button
                        type="button"
                        class="repo-card"
                        classList={{ selected: isSel() }}
                        onClick={() => setSelected(isSel() ? null : item)}
                      >
                        <div class="repo-card-text">
                          <span class="repo-card-title">
                            {item.kind === "pr" ? "PR" : "Issue"} #{item.number} · {item.title}
                          </span>
                          <span class="repo-card-sub">
                            {item.author ? `${item.author} · ` : ""}updated {relTime(item.updatedAt)}
                          </span>
                        </div>
                        <span class="repo-card-action">{isSel() ? "Selected" : "Select"}</span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        </Match>
      </Switch>

      <div class="dialog-preview">
        <div class="dialog-preview-title">Workspace preview</div>
        <For each={previewRows()}>
          {([label, value]) => (
            <div class="dialog-preview-row">
              <span class="dialog-preview-label">{label}</span>
              <span class="dialog-preview-value">{value}</span>
            </div>
          )}
        </For>
      </div>

      <Show when={error()}>{(msg) => <div class="dialog-error">{msg()}</div>}</Show>
      <Show when={missingRequirement()}>{(msg) => <div class="dialog-hint">{msg()}</div>}</Show>
      <div class="dialog-actions">
        <button class="ui-button" onClick={props.onDone}>Cancel</button>
        <button
          class="ui-button-primary"
          disabled={!canSubmit()}
          title={submitTitle()}
          onClick={() => submit()}
        >
          {submitLabel()}
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
        <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.linkWorkspaceDirectory(props.workspace, target().trim()).then(() => refetchLinks()))}>Link</button>
        <button class="ui-button-sm" disabled={busy()} onClick={() => submit(() => actions.unlinkWorkspaceDirectory(props.workspace, target().trim()).then(() => refetchLinks()))}>Unlink</button>
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

function ConfirmForm(props: { spec: ConfirmSpec; onDone: () => void }) {
  const [value, setValue] = createSignal(props.spec.input?.initialValue ?? "");
  const ok = () => !props.spec.input || value().trim().length > 0;
  const run = () => {
    if (!ok()) return;
    props.spec.onConfirm(props.spec.input ? value().trim() : undefined);
    props.onDone();
  };
  return (
    <div class="dialog-form">
      <div class="dialog-message">{props.spec.message}</div>
      <Show when={props.spec.input}>
        {(inp) => (
          <label class="dialog-field">
            <span>{inp().label}</span>
            <input
              value={value()}
              ref={(el) => setTimeout(() => el.focus(), 0)}
              onInput={(e) => setValue(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
            />
          </label>
        )}
      </Show>
      <div class="dialog-actions">
        <button class="ui-button" onClick={props.onDone}>
          Cancel
        </button>
        <button
          class={props.spec.destructive ? "ui-button-destructive" : "ui-button"}
          disabled={!ok()}
          onClick={run}
        >
          {props.spec.confirmLabel}
        </button>
      </div>
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
          <Match when={s().kind === "confirm"}>
            <Modal title={(s() as ConfirmSpec).title} onClose={close}>
              <ConfirmForm spec={s() as ConfirmSpec} onDone={close} />
            </Modal>
          </Match>
        </Switch>
      )}
    </Show>
  );
}
