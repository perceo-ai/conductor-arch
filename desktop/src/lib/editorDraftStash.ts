// Unsaved file-editor text, keyed by workspace:path. The file editor lives
// inside the chat surface, which a pane focus change in a split unmounts and
// remounts (the compact pane renders the chat leaf alone) — without this, a
// click into the other pane silently discarded the edits. The stash also
// means close-and-reopen of a file tab keeps unsaved work, matching the
// composer's draft behavior.

const stash = new Map<string, string>();

function key(workspace: string, path: string): string {
  return `${workspace}:${path}`;
}

export const editorDraftStash = {
  /** Park unsaved text (`null`/clean clears any stale entry instead). */
  park(workspace: string, path: string, draft: string | null): void {
    if (draft == null) stash.delete(key(workspace, path));
    else stash.set(key(workspace, path), draft);
  },
  /** Take the parked text back, removing it from the stash. */
  take(workspace: string, path: string): string | null {
    const k = key(workspace, path);
    const parked = stash.get(k) ?? null;
    stash.delete(k);
    return parked;
  },
  /** A successful save makes any parked copy stale. */
  clear(workspace: string, path: string): void {
    stash.delete(key(workspace, path));
  },
};
