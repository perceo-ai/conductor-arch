// Tiny bridge so the right-panel Browse/Changes lists can open a file tab in the
// center (ChatSurface). ChatSurface registers the handler on mount; the right
// panel calls open(). Kept in its own module to avoid a CommandCenter <->
// ChatSurface import cycle.

let handler: ((workspace: string, path: string) => void) | null = null;

export function registerOpenFile(fn: (workspace: string, path: string) => void) {
  handler = fn;
}

export function openFileInCenter(workspace: string, path: string) {
  handler?.(workspace, path);
}
