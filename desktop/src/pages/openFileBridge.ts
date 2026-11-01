import type { WorkspaceChangeScope } from "@/bridge/protocol";
import { actions } from "@/store/actions";

// Tiny bridge so Browse/Changes panels can open a file tab in ChatSurface.
// ChatSurface registers a handler per workspace on mount; panels call open().
// Kept in its own module to avoid a CommandCenter <-> ChatSurface import
// cycle. Keyed by workspace because a split mounts two chat surfaces at once —
// a single slot left whichever surface registered last answering for both,
// silently dropping the other workspace's opens.

// The scope travels with the path so the opened file shows the same set of
// changes the list it was picked from was showing.
type OpenFile = (path: string, scope?: WorkspaceChangeScope) => void;
type OpenCommit = (commit: string) => void;

const fileHandlers = new Map<string, OpenFile>();
const commitHandlers = new Map<string, OpenCommit>();

function register<T>(handlers: Map<string, T>, workspace: string, fn: T): () => void {
  handlers.set(workspace, fn);
  return () => {
    if (handlers.get(workspace) === fn) handlers.delete(workspace);
  };
}

/** Register `workspace`'s file-open handler; returns the deregistration. */
export function registerOpenFile(workspace: string, fn: OpenFile): () => void {
  return register(fileHandlers, workspace, fn);
}

export function openFileInCenter(
  workspace: string,
  path: string,
  scope?: WorkspaceChangeScope,
) {
  actions.revealPanel("chat");
  fileHandlers.get(workspace)?.(path, scope);
}

/** Register `workspace`'s commit-open handler; returns the deregistration. */
export function registerOpenCommit(workspace: string, fn: OpenCommit): () => void {
  return register(commitHandlers, workspace, fn);
}

export function openCommitInCenter(workspace: string, commit: string) {
  actions.revealPanel("chat");
  commitHandlers.get(workspace)?.(commit);
}
