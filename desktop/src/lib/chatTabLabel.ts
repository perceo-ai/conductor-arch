// The chat-tab label. Chats are named server-side — the agent supplies a title
// through `set_workspace_context`/its metadata block, and the naming floor
// derives one from the first request — so the tab must read that title rather
// than its own position. Position is only the fallback for a chat that is still
// wearing the placeholder the backend opens it on.
export function chatTabLabel(title: string | undefined, index: number): string {
  const trimmed = (title ?? "").trim();
  if (trimmed === "" || trimmed.toLowerCase() === "new chat") return `Chat ${index + 1}`;
  return trimmed;
}
