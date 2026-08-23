import { For, Show, createMemo, createResource } from "solid-js";
import {
  newChatContextStore,
  workspacesStore,
} from "@/store";
import { send } from "@/bridge/client";
import type {
  ArchcarChatTranscriptSummary,
  ArchcarContextPlan,
} from "@/bridge/protocol";
import Icon from "@/components/Icon";
import {
  formatPlan,
  formatTranscript,
  planPickKey,
  transcriptChipDetail,
  transcriptPickKey,
} from "@/lib/newChatContext";

// Empty-state for a chat with no messages yet: what this workspace is, plus
// context worth seeding the first prompt with.
// Empty-chat screen: name the branch this chat runs on, then offer the context
// a fresh chat usually needs — recent chat transcripts (conversation only, no
// tool calls) and plan markdown from `.context/plans/`. Picked chips ride along
// with the first message the composer sends.
export function NewChatIntro(props: { workspace: string; threadId: number }) {
  const branch = () => workspacesStore.row(props.workspace)?.branch ?? props.workspace;

  const [transcripts] = createResource(
    () => props.workspace,
    async (workspace) => {
      try {
        const res = await send({ type: "list_chat_transcripts", workspace });
        return res.type === "chat_transcripts" ? res.transcripts : [];
      } catch {
        return [];
      }
    },
  );
  const [plans] = createResource(
    () => props.workspace,
    async (workspace) => {
      try {
        const res = await send({ type: "list_context_plans", workspace });
        return res.type === "context_plans" ? res.plans : [];
      } catch {
        return [];
      }
    },
  );

  // This chat has no messages yet, so it never lists itself.
  const pastChats = createMemo(() =>
    (transcripts() ?? []).filter((t) => t.thread_id !== props.threadId),
  );
  const selected = (key: string) => newChatContextStore.selected(props.threadId, key);

  async function toggleTranscript(summary: ArchcarChatTranscriptSummary) {
    const key = transcriptPickKey(summary.thread_id);
    if (selected(key)) {
      newChatContextStore.remove(props.threadId, key);
      return;
    }
    try {
      const res = await send({ type: "get_chat_transcript", thread_id: summary.thread_id });
      if (res.type !== "chat_transcript") return;
      newChatContextStore.toggle(props.threadId, {
        key,
        kind: "transcript",
        label: res.title || summary.title,
        body: formatTranscript(res.title || summary.title, res.messages)
      });
    } catch {
      // non-fatal: leave the chip unselected
    }
  }

  async function togglePlan(plan: ArchcarContextPlan) {
    const key = planPickKey(plan.path);
    if (selected(key)) {
      newChatContextStore.remove(props.threadId, key);
      return;
    }
    try {
      const res = await send({
        type: "read_workspace_file",
        workspace: props.workspace,
        path: plan.path
      });
      if (res.type !== "workspace_file_content") return;
      newChatContextStore.toggle(props.threadId, {
        key,
        kind: "plan",
        label: plan.title,
        body: formatPlan(plan.title, plan.path, res.content)
      });
    } catch {
      // non-fatal: leave the chip unselected
    }
  }

  return (
    <div class="new-chat-intro">
      <div class="new-chat-title">
        New chat in <span class="new-chat-branch">{branch()}</span>
      </div>

      <div class="new-chat-section">
        <div class="new-chat-section-label">Add chat transcripts</div>
        <Show
          when={pastChats().length > 0}
          fallback={
            <div class="new-chat-hint">
              {transcripts.loading ? "Loading…" : "No past chats in this workspace yet."}
            </div>
          }
        >
          <div class="new-chat-chips">
            <For each={pastChats()}>
              {(summary) => (
                <button
                  class="new-chat-chip"
                  classList={{ "new-chat-chip-on": selected(transcriptPickKey(summary.thread_id)) }}
                  title={`${summary.provider} · ${summary.updated_at}`}
                  onClick={() => void toggleTranscript(summary)}
                >
                  <Icon
                    name={selected(transcriptPickKey(summary.thread_id)) ? "circle-check" : "history"}
                  />
                  <span class="new-chat-chip-label">{summary.title}</span>
                  <span class="new-chat-chip-detail">
                    {transcriptChipDetail(summary.message_count)}
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="new-chat-section">
        <div class="new-chat-section-label">Add plans</div>
        <Show
          when={(plans() ?? []).length > 0}
          fallback={
            <div class="new-chat-hint">
              {plans.loading ? "Loading…" : "No plans saved in .context/plans/ yet."}
            </div>
          }
        >
          <div class="new-chat-chips">
            <For each={plans() ?? []}>
              {(plan) => (
                <button
                  class="new-chat-chip"
                  classList={{ "new-chat-chip-on": selected(planPickKey(plan.path)) }}
                  title={plan.path}
                  onClick={() => void togglePlan(plan)}
                >
                  <Icon name={selected(planPickKey(plan.path)) ? "circle-check" : "file-text"} />
                  <span class="new-chat-chip-label">{plan.title}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

