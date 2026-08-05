// Renderer-side wrapper around the preload bridge (window.archductor).
import type { ArchcarRequest, ArchcarResponse, ArchcarEvent } from "./protocol";

export interface GithubRepo {
  nameWithOwner: string;
  name: string;
  sshUrl: string;
  url: string;
  pushedAt: string;
  owner: string;
  avatarUrl: string;
}

export interface GithubWorkItem {
  kind: "issue" | "pr";
  number: number;
  title: string;
  updatedAt: string;
  author: string;
}

interface ArchductorApi {
  request<Res = unknown>(payload: unknown): Promise<Res>;
  ensureEvents(): Promise<{ ok: boolean }>;
  onEvent(cb: (event: unknown) => void): () => void;
  onWindowFocus(cb: (focused: boolean) => void): () => void;
  window: { minimize(): void; toggleMaximize(): void; close(): void };
  selectFolder(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;
  listGithubRepos(): Promise<{ ok: true; repos: GithubRepo[] } | { ok: false; error: string }>;
  listGithubWork(opts: { rootPath: string }): Promise<
    { ok: true; items: GithubWorkItem[] } | { ok: false; error: string }
  >;
  pathExists(p: string): Promise<{ exists: boolean }>;
  repoAvatar(opts: { rootPath: string; remoteName?: string }): Promise<
    { ok: true; avatarUrl: string } | { ok: false; error: string }
  >;
  openExternal(target: string): Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    archductor: ArchductorApi;
  }
}

const api = () => window.archductor;

/** Typed request to archcar. */
export function send<R extends ArchcarResponse = ArchcarResponse>(
  req: ArchcarRequest,
): Promise<R> {
  return api().request<R>(req);
}

/** Ensure the event stream is running and route events to a handler. */
export async function connectEvents(onEvent: (event: ArchcarEvent) => void): Promise<() => void> {
  const off = api().onEvent((e) => onEvent(e as ArchcarEvent));
  try {
    await api().ensureEvents();
  } catch (err) {
    // Don't leak the listener when startup fails; a retry re-registers cleanly.
    off();
    throw err;
  }
  return off;
}

export const onWindowFocus = (cb: (focused: boolean) => void) => api().onWindowFocus(cb);
export const windowControls = () => api().window;

/** Open a native folder picker; resolves to the chosen path or null if cancelled. */
export const selectFolder = (opts?: { title?: string; defaultPath?: string }) => api().selectFolder(opts);

/** List the signed-in user's GitHub repos via gh. */
export const listGithubRepos = () => api().listGithubRepos();

/** List open GitHub issues + PRs for a repo via gh. */
export const listGithubWork = (opts: { rootPath: string }) => api().listGithubWork(opts);

/** Check whether a filesystem path currently exists. */
export const pathExists = (p: string) => api().pathExists(p);

/** Resolve a local repo's owner avatar URL from its git remote. */
export const repoAvatar = (opts: { rootPath: string; remoteName?: string }) =>
  api().repoAvatar(opts);

/** Open a URL in the browser or a filesystem path in the OS default app. */
export const openExternal = (target: string) => api().openExternal(target);
