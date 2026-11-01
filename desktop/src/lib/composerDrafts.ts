import type { ComposerNode } from "./composerDocument";

// Unsent composer text, per chat thread. Switching chats — or workspace tabs —
// remounts or re-points the composer; without this the half-written prompt
// either vanished or followed the user into the next chat.
const drafts = new Map<number, ComposerNode[]>();

export const composerDrafts = {
  get(threadId: number): ComposerNode[] {
    return drafts.get(threadId) ?? [];
  },
  save(threadId: number, nodes: ComposerNode[]): void {
    if (nodes.length === 0) drafts.delete(threadId);
    else drafts.set(threadId, nodes);
  },
};
