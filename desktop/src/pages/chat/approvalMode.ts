import type { ArchcarRequest, ArchcarResponse } from "@/bridge/protocol";

/**
 * The per-thread "ask before tools" opt-in.
 *
 * Kept out of the composer so it can be tested without rendering one: the bug
 * this guards against was pure toggle logic, not markup.
 */

/** Off is the absence of an opt-in, which is the mode every thread ran in before. */
export const APPROVAL_MODE_ASK = "default";
export const APPROVAL_MODE_BYPASS = "bypassPermissions";

/**
 * Only claude routes tool calls through `can_use_tool`. Codex reads these mode
 * strings as something else entirely and ACP rejects them outright, so the
 * toggle has no meaning there.
 */
export function supportsApprovalMode(provider: string): boolean {
  return provider === "claude";
}

/**
 * The request a toggle click sends.
 *
 * Thread-scoped, not session-scoped: a brand-new chat and any thread after an
 * app relaunch have no live session, and those are exactly the threads whose
 * opt-in has to survive to the next launch.
 */
export function approvalModeRequest(threadId: number, ask: boolean): ArchcarRequest {
  return {
    type: "set_chat_approval_mode",
    thread_id: threadId,
    mode: ask ? APPROVAL_MODE_ASK : APPROVAL_MODE_BYPASS,
  };
}

/**
 * Flip the toggle optimistically, persist it, and roll back if the daemon says
 * no. Sends unconditionally — a no-op without a session would light the toggle
 * up, write nothing, and let the next `applySnapshot` quietly flip it back.
 */
export async function applyApprovalMode(opts: {
  threadId: number;
  ask: boolean;
  send: (request: ArchcarRequest) => Promise<ArchcarResponse>;
  setApprovalMode: (threadId: number, on: boolean) => void;
  onError: (err: unknown) => void;
}): Promise<void> {
  const { threadId, ask, send, setApprovalMode, onError } = opts;
  setApprovalMode(threadId, ask);
  try {
    const res = await send(approvalModeRequest(threadId, ask));
    if (res.type === "error") throw new Error(res.message);
  } catch (err) {
    setApprovalMode(threadId, !ask);
    onError(err);
  }
}
