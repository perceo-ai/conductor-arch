import { Show, createMemo, createResource, createSignal } from "solid-js";
import { send, openExternal } from "@/bridge/client";
import { actions, workspacesStore, toastsStore } from "@/store";
import type { ArchcarChecksSummary } from "@/bridge/protocol";

// Right-panel top region — port of the GTK workspace PR status panel
// (workspace_command_center.rs::workspace_pr_status). Shows the PR chip, a
// one-line status, and a single color-coded primary action that moves the
// workflow forward. Data comes from the workspace summary (PR number/state/url)
// plus get_checks_summary (check/run status, ahead/behind, conflicts).

type ActionKind = "push" | "merge" | "view" | "none";

interface PrState {
  title: string;
  cssClass: string; // ws-pr-status-{muted,pending,failed,merged,ready}
  actionLabel?: string;
  action: ActionKind;
}

function derive(
  row: ReturnType<typeof workspacesStore.row>,
  checks: ArchcarChecksSummary | undefined,
): PrState {
  const prNumber = row?.prNumber;
  const prState = (row?.prState ?? "").toLowerCase();
  const check = (checks?.check_status ?? "").toLowerCase();
  const ahead = checks?.branch_ahead ?? checks?.source_branch_ahead ?? 0;
  const behind = checks?.branch_behind ?? 0;
  const conflicts = checks?.conflicting_workspaces ?? 0;
  const changed = row?.changedFiles ?? 0;

  // No PR yet: guide toward pushing so a PR can be opened.
  if (!prNumber) {
    if (ahead > 0 || changed > 0)
      return { title: "No pull request yet", cssClass: "ws-pr-status-muted", actionLabel: "Push branch", action: "push" };
    return { title: "No changes to publish", cssClass: "ws-pr-status-muted", action: "none" };
  }

  if (prState === "merged")
    return { title: `#${prNumber} merged`, cssClass: "ws-pr-status-merged", actionLabel: "View PR", action: "view" };
  if (prState === "closed")
    return { title: `#${prNumber} closed`, cssClass: "ws-pr-status-muted", actionLabel: "View PR", action: "view" };

  // Open PR.
  if (conflicts > 0)
    return { title: "Merge conflicts", cssClass: "ws-pr-status-failed", actionLabel: "View PR", action: "view" };
  if (check === "failing" || check === "failure" || check === "error")
    return { title: "Checks failing", cssClass: "ws-pr-status-failed", actionLabel: "View PR", action: "view" };
  if (ahead > 0)
    return { title: "Unpushed commits", cssClass: "ws-pr-status-pending", actionLabel: "Push branch", action: "push" };
  if (check === "pending" || check === "running" || check === "queued")
    return { title: "Checks running", cssClass: "ws-pr-status-pending", actionLabel: "View PR", action: "view" };
  if (behind > 0)
    return { title: "Behind base branch", cssClass: "ws-pr-status-pending", actionLabel: "View PR", action: "view" };
  return { title: "Ready to merge", cssClass: "ws-pr-status-ready", actionLabel: "Merge", action: "merge" };
}

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
  const st = createMemo(() => derive(row(), checks()));

  async function runAction() {
    const action = st().action;
    if (action === "none" || busy()) return;
    const url = row()?.prUrl;
    setBusy(true);
    try {
      if (action === "view" && url) await openExternal(url);
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
