import type { WorkspaceChangeScope } from "@/bridge/protocol";
import { actions } from "@/store/actions";

// Tiny bridge so Browse/Changes panels can open a file tab in ChatSurface.
// ChatSurface registers the handler on mount; panels call open(). Kept in its
// own module to avoid a CommandCenter <->
// ChatSurface import cycle.

// The scope travels with the path so the opened file shows the same set of
// changes the list it was picked from was showing.
type OpenFile = (workspace: string, path: string, scope?: WorkspaceChangeScope) => void;

let handler: OpenFile | null = null;

export function registerOpenFile(fn: OpenFile) {
  handler = fn;
}

export function openFileInCenter(
  workspace: string,
  path: string,
  scope?: WorkspaceChangeScope,
) {
  actions.revealPanel("chat");
  handler?.(workspace, path, scope);
}

// Same pattern for opening a commit's diff in the center.
let commitHandler: ((workspace: string, commit: string) => void) | null = null;

export function registerOpenCommit(fn: (workspace: string, commit: string) => void) {
  commitHandler = fn;
}

export function openCommitInCenter(workspace: string, commit: string) {
  actions.revealPanel("chat");
  commitHandler?.(workspace, commit);
}
