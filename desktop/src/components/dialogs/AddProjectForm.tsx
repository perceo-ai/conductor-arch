import { createSignal, createResource, Show,  For } from "solid-js";
import {
  actions
} from "@/store";
import {
  selectFolder,
  listGithubRepos,
  remoteDaemon,
  type GithubRepo
} from "@/bridge/client";
import {  useSubmit, joinPath, relTime, RepoCardAvatar } from "./DialogShared";

// Global modal host. Renders the form for the active dialog spec. Every form
// calls into `actions.*`, which logs the action, sends the archcar request, and
// re-pulls the inventory on success.

// Add an existing repository, clone one, or pick from the user's GitHub repos.
export function AddProjectForm(props: { onDone: () => void }) {
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

  // Paths typed here are resolved by the daemon. Pointed at a remote, the
  // native picker would browse this machine's disk and hand back a path the
  // server cannot see, so it is disabled rather than quietly misleading.
  const [remote] = createResource(async () => {
    try {
      const res = await remoteDaemon.get();
      return res.ok && res.address ? res.address : null;
    } catch {
      return null;
    }
  });
  const remoteAddress = () => remote() ?? null;

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
                        <RepoCardAvatar repo={repo} />
                        <div class="repo-card-text">
                          <span class="repo-card-title">{repo.nameWithOwner || repo.name}</span>
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
              <button
                class="ui-button-sm"
                disabled={!!remoteAddress()}
                title={remoteAddress() ? `Paths are resolved on ${remoteAddress()}` : undefined}
                onClick={() => pickFolder(setParentDir, "Choose destination folder")}
              >
                Browse…
              </button>
            </div>
            <Show when={dest()}>
              <span class="dialog-hint">Clones into {dest()}</span>
            </Show>
            <Show when={remoteAddress()}>
              <span class="dialog-hint">Path on the daemon host ({remoteAddress()}), not this machine.</span>
            </Show>
          </label>
        </>
      }>
        <label class="dialog-field">
          <span>Repository path</span>
          <div class="dialog-field-row">
            <input value={path()} onInput={(e) => setPath(e.currentTarget.value)} placeholder="/home/you/code/repo" />
            <button
              class="ui-button-sm"
              disabled={!!remoteAddress()}
              title={remoteAddress() ? `Paths are resolved on ${remoteAddress()}` : undefined}
              onClick={() => pickFolder(setPath, "Select repository folder")}
            >
              Browse…
            </button>
          </div>
          <Show when={remoteAddress()}>
            <span class="dialog-hint">Path on the daemon host ({remoteAddress()}), not this machine.</span>
          </Show>
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
