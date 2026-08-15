import { contextBridge, ipcRenderer } from "electron";

// Typed, isolated bridge exposed to the renderer as window.archductor.
// The renderer never touches the socket or Node APIs directly.
const api = {
  /** Send a request to archcar; resolves with the ArchcarResponse payload. */
  request: async <Res = unknown>(payload: unknown): Promise<Res> => {
    const res = (await ipcRenderer.invoke("archcar:request", payload)) as
      | { ok: true; value: Res }
      | { ok: false; error: string };
    if (!res.ok) throw new Error(res.error);
    return res.value;
  },

  /** Ensure the event subscription is running. Idempotent. */
  ensureEvents: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("archcar:subscribe"),

  /** Open a native folder picker; resolves to the chosen path or null if cancelled. */
  selectFolder: (opts?: { title?: string; defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke("dialog:select-folder", opts),

  /** List the signed-in user's GitHub repos via the gh CLI. */
  listGithubRepos: (): Promise<
    | { ok: true; repos: { nameWithOwner: string; name: string; sshUrl: string; url: string; pushedAt: string; owner: string; avatarUrl: string }[] }
    | { ok: false; error: string }
  > => ipcRenderer.invoke("gh:list-repos"),

  /** List open GitHub issues + PRs for a repo via the gh CLI. */
  listGithubWork: (opts: { rootPath: string }): Promise<
    | { ok: true; items: { kind: "issue" | "pr"; number: number; title: string; updatedAt: string; author: string }[] }
    | { ok: false; error: string }
  > => ipcRenderer.invoke("gh:list-work", opts),

  /** Check whether a filesystem path currently exists. */
  pathExists: (p: string): Promise<{ exists: boolean }> =>
    ipcRenderer.invoke("fs:path-exists", p),

  /** Resolve a local repo's owner avatar URL from its git remote. */
  repoAvatar: (opts: { rootPath: string; remoteName?: string }): Promise<
    { ok: true; avatarUrl: string } | { ok: false; error: string }
  > => ipcRenderer.invoke("gh:repo-avatar", opts),

  /** Register a listener for the archcar event stream. Returns an unsubscribe fn. */
  onEvent: (cb: (event: unknown) => void): (() => void) => {
    const handler = (_e: unknown, event: unknown) => cb(event);
    ipcRenderer.on("archcar:event", handler);
    return () => ipcRenderer.off("archcar:event", handler);
  },

  /** Window focus changes (for foreground-gated sampling parity with gtk-app). */
  onWindowFocus: (cb: (focused: boolean) => void): (() => void) => {
    const handler = (_e: unknown, focused: boolean) => cb(focused);
    ipcRenderer.on("window:focus", handler);
    return () => ipcRenderer.off("window:focus", handler);
  },

  /** Open a URL in the browser or a path in the OS default app. */
  openExternal: (target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("shell:open-external", target),

  /** Current remote-daemon connection (address only; the token stays in main). */
  remoteGet: (): Promise<
    { ok: true; address: string | null; source: "environment" | "profile" | null } | { ok: false; error: string }
  > => ipcRenderer.invoke("archcar:remote-get"),

  /** Point the app (and this machine's CLI) at a server-hosted daemon. */
  remoteSet: (config: { address: string; token: string }): Promise<
    { ok: true; address: string } | { ok: false; error: string }
  > => ipcRenderer.invoke("archcar:remote-set", config),

  /** Clear the remote profile and go back to the local daemon. */
  remoteClear: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("archcar:remote-clear"),

  /** Check the latest published GitHub release; install remains manual. */
  checkForUpdates: (): Promise<
    | { ok: true; currentVersion: string; latestVersion?: string; updateAvailable: boolean; releaseUrl?: string }
    | { ok: false; currentVersion: string; error: string }
  > => ipcRenderer.invoke("app:check-for-updates"),

  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
  },

  /** Forward a structured renderer log entry to the main-process logfile. */
  log: (entry: { ts: number; category: string; message: string; data?: unknown }) =>
    ipcRenderer.send("app:log", entry),
};

contextBridge.exposeInMainWorld("archductor", api);

export type ArchductorApi = typeof api;
