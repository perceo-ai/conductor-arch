import { send } from "@/bridge/client";
import type { ArchcarInputKind, SessionKind } from "@/bridge/protocol";

export interface QueueManagedChatInput {
  workspace: string;
  threadId: number;
  input: string;
  visibleInput?: string;
  kind: Exclude<ArchcarInputKind, "raw_terminal">;
  sessionKind: SessionKind;
}

export async function queueManagedChatInput(input: QueueManagedChatInput): Promise<void> {
  await send({
    type: "ensure_chat_thread_session",
    workspace: input.workspace,
    thread_id: input.threadId,
    kind: input.sessionKind,
  });
  await send({
    type: "queue_chat_input",
    thread_id: input.threadId,
    input: input.input,
    visible_input: input.visibleInput,
    kind: input.kind,
    session_kind: input.sessionKind,
  });
}
