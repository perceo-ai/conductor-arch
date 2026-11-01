// Unsent composer text, per chat thread. Switching chats — or workspace tabs —
// remounts or re-points the composer; without this the half-written prompt
// either vanished or followed the user into the next chat.
//
// Keys are `"<realm>:<threadId>"` (see draftKey): thread ids are one daemon's
// numbering, so after a daemon switch plain ids would surface another
// daemon's draft in an unrelated conversation.
import type { ComposerNode } from "./composerDocument";

const drafts = new Map<string, ComposerNode[]>();

/** Storage key for a thread's draft; `realm` is nav.tabRealm() at selection time. */
export function draftKey(realm: string, threadId: number): string {
  return `${realm}:${threadId}`;
}

export const composerDrafts = {
  get(key: string): ComposerNode[] {
    return drafts.get(key) ?? [];
  },
  save(key: string, nodes: ComposerNode[]): void {
    if (nodes.length === 0) drafts.delete(key);
    else drafts.set(key, nodes);
  },
  /**
   * Startup correcting the provisional realm renames the realm, not the
   * daemon: every draft parked under it — not just the mounted composer's —
   * belongs to the corrected key. No real realm is a prefix of another
   * ("local", "client:<id>", "env:<address>"), so the prefix match is exact.
   */
  retargetRealm(from: string, to: string): void {
    if (from === to) return;
    const prefix = `${from}:`;
    for (const [key, nodes] of [...drafts]) {
      if (!key.startsWith(prefix)) continue;
      drafts.delete(key);
      drafts.set(`${to}:${key.slice(prefix.length)}`, nodes);
    }
  },
};
