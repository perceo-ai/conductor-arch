import { Show, createMemo, createResource, createSignal } from "solid-js";
import { send, openExternal } from "@/bridge/client";
import { actions, workspacesStore, toastsStore } from "@/store";
import type { ArchcarChecksSummary } from "@/bridge/protocol";
import { deriveWorkspacePrAction, workspacePrActionInput } from "@/lib/workspacePrAction";

// Compact top-nav PR control. This keeps PR management present without making
// it a peer surface beside chat. Data comes from the workspace summary
// (PR number/state/url) plus get_checks_summary (check/run status,
// ahead/behind, conflicts).

export default function WorkspacePrBar(props: { workspace: string }) {
  const [busy, setBusy] = createSignal(false);
  const [checks, { refetch }] = createResource(
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

  const row = () => workspacesStore.row(props.workspace);
  const st = createMemo(() => deriveWorkspacePrAction(workspacePrActionInput(row(), checks())));

  async function createPullRequest() {
    const draft = await send({ type: "get_pull_request_draft", workspace: props.workspace });
    if (draft.type === "error") throw new Error(draft.message);
    if (draft.type !== "pull_request_draft") throw new Error("Unable to draft pull request.");
    const res = await send({
      type: "create_pull_request",
      workspace: props.workspace,
      title: draft.title.trim(),
      body: draft.body.trim(),
      draft: false,
    });
    if (res.type === "error") throw new Error(res.message);
    if (res.type !== "pull_request_created") throw new Error("Pull request was not created.");
    toastsStore.push(res.output.trim() || "Pull request created.");
  }

  async function runAction() {
    const action = st().action;
    if (action === "none" || busy()) return;
    const url = row()?.prUrl;
    setBusy(true);
    try {
      if (action === "view" && url) await openExternal(url);
      else if (action === "create") await createPullRequest();
      else if (action === "push") await actions.pushBranch(props.workspace);
      else if (action === "merge") await actions.mergePullRequest(props.workspace);
      await refresh();
    } catch (e) {
      toastsStore.error(`Action failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    try {
      await actions.refreshPullRequest(props.workspace).catch(() => {});
      await workspacesStore.refresh().catch(() => {});
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="ws-pr-bar" classList={{ [st().cssClass]: true }}>
      <Show
        when={row()?.prNumber}
        fallback={<span class="ws-pr-chip ws-pr-chip-empty">No PR</span>}
      >
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
      <Show when={st().actionLabel}>
        <button class="ws-pr-action-button" disabled={busy()} onClick={() => void runAction()}>
          {busy() ? "…" : st().actionLabel}
        </button>
      </Show>
    </div>
  );
}
