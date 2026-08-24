import { Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { send, openExternal } from "@/bridge/client";
import { nav, threadsStore, workspacesStore, toastsStore } from "@/store";
import type { ArchcarChatThread, ArchcarChecksSummary, SessionKind, WorkspaceGitAction } from "@/bridge/protocol";
import {
  WORKSPACE_PR_STATE_ICON,
  WORKSPACE_PR_STATE_MOTION,
  deriveWorkspacePrAction,
  workspacePrActionInput,
} from "@/lib/workspacePrAction";
import Icon from "@/components/Icon";

// Compact top-nav PR control. This keeps PR management present without making
// it a peer surface beside chat. Data comes from the workspace summary
// (PR number/state/url) plus get_checks_summary (check/run status,
// ahead/behind, conflicts).

export default function WorkspacePrBar(props: { workspace: string }) {
  const [busy, setBusy] = createSignal(false);
  const [checks, { refetch: refetchChecks }] = createResource(
    () => props.workspace,
    async (ws): Promise<ArchcarChecksSummary | undefined> => {
      try {
        const res = await send({ type: "get_checks_summary", workspace: ws });
        return res.type === "checks_summary" ? res.summary : undefined;
      } catch {
        return undefined;
      }
    },
  );

  onMount(() => {
    const timer = window.setInterval(() => {
      void refetchChecks();
    }, 10_000);
    onCleanup(() => window.clearInterval(timer));
  });

  const row = () => workspacesStore.row(props.workspace);
  const st = createMemo(() => deriveWorkspacePrAction(workspacePrActionInput(row(), checks())));

  function providerKind(provider: string): SessionKind {
    const p = provider.toLowerCase();
    if (p.includes("claude")) return "claude";
    if (p.includes("shell")) return "shell";
    return "codex";
  }

  function gitAction(): WorkspaceGitAction | null {
    const action = st().action;
    if (action === "create") return "create_pr";
    if (action === "push") return "push_branch";
    if (action === "merge") return "merge_pr";
    if (action === "view") return "open_pr";
    return null;
  }

  async function activeChatThread(): Promise<ArchcarChatThread> {
    const loaded = threadsStore.list(props.workspace);
    let threads = loaded.length > 0 ? loaded : await threadsStore.refresh(props.workspace);
    threads = threads.filter((thread) => thread.provider !== "shell");
    const selected = nav.selectedChatThread();
    const existing = threads.find((thread) => thread.id === selected) ?? threads[0];
    if (existing) return existing;
    const created = await send({
      type: "create_chat_thread",
      workspace: props.workspace,
      provider: "codex",
      title: "Git control",
    });
    if (created.type !== "chat_thread_created") throw new Error("Unable to create chat thread.");
    await threadsStore.refresh(props.workspace);
    return created.thread;
  }

  async function queueAgentAction() {
    const action = gitAction();
    if (!action) return;
    const thread = await activeChatThread();
    const prompt = await send({ type: "get_workspace_git_action_prompt", workspace: props.workspace, action });
    if (prompt.type === "error") throw new Error(prompt.message);
    if (prompt.type !== "workspace_git_action_prompt") throw new Error("Unable to prepare agent prompt.");
    nav.selectChatThread(thread.id);
    await send({
      type: "ensure_chat_thread_session",
      workspace: props.workspace,
      thread_id: thread.id,
      kind: providerKind(thread.provider),
    });
    await send({
      type: "queue_chat_input",
      thread_id: thread.id,
      input: prompt.prompt,
      visible_input: prompt.visible_input,
      kind: "control_command",
      session_kind: providerKind(thread.provider),
    });
    toastsStore.push(`${prompt.visible_input} queued in chat.`);
  }

  async function runAction() {
    const action = st().action;
    if (action === "none" || busy()) return;
    setBusy(true);
    try {
      await queueAgentAction();
    } catch (e) {
      toastsStore.error(`Action failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="ws-pr-bar" classList={{ [st().cssClass]: true }}>
      {/* Same glyph and colour the sidebar row shows for this workspace, so the
          two surfaces cannot describe the same PR differently. */}
      <span
        class={`workspace-git-state workspace-git-state-${st().state}`}
        classList={{
          [`workspace-git-state-motion-${WORKSPACE_PR_STATE_MOTION[st().state]}`]:
            WORKSPACE_PR_STATE_MOTION[st().state] != null,
        }}
        title={st().title}
      >
        <Icon name={WORKSPACE_PR_STATE_ICON[st().state]} />
      </span>
      <Show when={row()?.prNumber}>
        <button
          class="ws-pr-chip"
          title="Open pull request"
          onClick={() => {
            const url = row()?.prUrl;
            if (url) void openExternal(url);
          }}
        >
          #{row()!.prNumber}
        </button>
      </Show>
      <span class="ws-pr-status-title">{st().title}</span>
      <button
        class="ws-pr-action-button"
        disabled={st().action === "none" || busy()}
        onClick={() => void runAction()}
      >
        {busy() ? "…" : (st().actionLabel ?? "Clean")}
      </button>
    </div>
  );
}
