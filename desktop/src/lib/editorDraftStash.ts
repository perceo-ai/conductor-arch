// Unsaved file-editor text, keyed by realm:workspace:path. The realm is the
// daemon's tab realm (nav.tabRealm()): workspace names only mean something on
// the daemon that issued them, so the same name+path on another daemon is a
// different file and must not get this one's edits. The file editor lives
// inside the chat surface, which a pane focus change in a split unmounts and
// remounts (the compact pane renders the chat leaf alone) — without this, a
// click into the other pane silently discarded the edits. The stash also
// means close-and-reopen of a file tab keeps unsaved work, matching the
// composer's draft behavior.

const stash = new Map<string, string>();

function key(realm: string, workspace: string, path: string): string {
  return `${realm}:${workspace}:${path}`;
}

export const editorDraftStash = {
  /** Park unsaved text (`null`/clean clears any stale entry instead). */
  park(realm: string, workspace: string, path: string, draft: string | null): void {
    if (draft == null) stash.delete(key(realm, workspace, path));
    else stash.set(key(realm, workspace, path), draft);
  },
  /** Take the parked text back, removing it from the stash. */
  take(realm: string, workspace: string, path: string): string | null {
    const k = key(realm, workspace, path);
    const parked = stash.get(k) ?? null;
    stash.delete(k);
    return parked;
  },
  /** A successful save makes any parked copy stale. */
  clear(realm: string, workspace: string, path: string): void {
    stash.delete(key(realm, workspace, path));
  },
  /**
   * Startup correcting the provisional realm renames the realm, not the
   * daemon: every draft parked under it belongs to the corrected key. Called
   * from nav's assignTabRealm so it runs whether or not the editor that
   * parked a draft is still mounted. The `workspace:path` remainder is kept
   * byte-for-byte — prefix replacement only.
   */
  migrateRealm(from: string, to: string): void {
    if (from === to) return;
    const prefix = `${from}:`;
    for (const [k, draft] of [...stash]) {
      if (!k.startsWith(prefix)) continue;
      stash.delete(k);
      stash.set(`${to}:${k.slice(prefix.length)}`, draft);
    }
  },
};
