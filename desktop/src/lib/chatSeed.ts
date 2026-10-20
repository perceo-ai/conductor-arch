import type { ArchcarChatThread } from "@/bridge/protocol";

// Which model a chat should be seeded with when it is selected. Chats created
// through newChat() are seeded there; chats the backend created on its own
// (the first chat of a brand-new workspace) arrive with no model, so selecting
// one must seed it the same way or the composer falls back to the provider's
// first model instead of the user's default.

/**
 * The seed to record for `thread`, or `undefined` when it needs none: it
 * already has a model, or a seed is already pending for it.
 */
export function seedForSelectedThread(
  thread: Pick<ArchcarChatThread, "id" | "provider" | "model">,
  pending: Record<number, string>,
  seedModelFor: (provider: string) => string,
): string | undefined {
  if (thread.model != null || thread.id in pending) return undefined;
  return seedModelFor(thread.provider) || undefined;
}
