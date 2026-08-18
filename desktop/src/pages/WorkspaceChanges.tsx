import { For, Show, createResource } from "solid-js";
import { send } from "@/bridge/client";
import type { DiffFileSummary, WorkspaceChangeScope } from "@/bridge/protocol";
import Diff from "@/components/Diff";
import Icon from "@/components/Icon";
import { langFromPath } from "@/lib/highlight";
import { openCommitInCenter } from "./openFileBridge";

// Changes views — port of workspace_changes_panel + workspace_diff_sections.
// The right panel shows the summary rows; the main Changes tab shows rows plus
// the three-section unified diff. Both fetch on demand via createResource.

function Counts(props: { file: DiffFileSummary }) {
  if (props.file.additions == null || props.file.deletions == null) {
    return <span class="ws-file-summary-counts">binary</span>;
  }
  return (
    <span class="ws-file-summary-counts">
      <span class="ws-file-additions">+{props.file.additions}</span>
      <span class="ws-file-deletions">-{props.file.deletions}</span>
    </span>
  );
}

function stateLabel(f: DiffFileSummary): string {
  if (f.untracked) return "[untracked]";
  if (f.staged && f.unstaged) return "[staged+unstaged]";
  if (f.staged) return "[staged]";
  if (f.unstaged) return "[unstaged]";
  return "[clean]";
}

function ChangeRow(props: { file: DiffFileSummary; showState: boolean; onOpen?: (path: string) => void }) {
  return (
    <button class="ws-file-summary-row-content" onClick={() => props.onOpen?.(props.file.path)}>
      <Icon name="file-code" class="ws-file-icon" />
      <span class="ws-file-name">{props.file.path}</span>
      <Show when={props.showState}>
        <span class="ws-file-summary-state">{stateLabel(props.file)}</span>
      </Show>
      <Counts file={props.file} />
    </button>
  );
}

export function ChangesRows(props: {
  workspace: string;
  defaultScope?: WorkspaceChangeScope;
  openFile?: (path: string) => void;
  showCommits?: boolean;
}) {
  const scope = props.defaultScope ?? "uncommitted";
  const [changes] = createResource(
    () => [props.workspace, scope] as const,
    async ([ws, sc]) => {
      try {
        const res = await send({ type: "get_workspace_changes", workspace: ws, scope: sc });
        return res.type === "workspace_changes" ? res.files : [];
      } catch {
        return [];
      }
    },
  );
  const [commits] = createResource(
    () => props.workspace,
    async (ws): Promise<string> => {
      try {
        const res = await send({ type: "get_recent_commits", workspace: ws, limit: 15 });
        return res.type === "recent_commits" ? res.log : "";
      } catch {
        return "";
      }
    },
  );
  return (
    <div class="ws-file-summary-panel">
      <div class="ws-changes-header">
        <span class="ws-changes-title">Changes</span>
        <span class="ws-panel-kicker">{scope === "all" ? "All" : "Uncommitted"}</span>
      </div>
      <Show
        when={(changes() ?? []).length > 0}
        fallback={<div class="empty-state">{changes.loading ? "Loading…" : "No changes"}</div>}
      >
        <For each={changes()}>
          {(file) => (
            <ChangeRow file={file} showState={scope === "uncommitted"} onOpen={props.openFile} />
          )}
        </For>
      </Show>
      <Show when={props.showCommits && (commits() ?? "").trim()}>
        <div class="ws-commits-section">
          <div class="ws-commits-head">
            <span class="section-title">Recent commits</span>
          </div>
          <For each={(commits() ?? "").split("\n").filter((l) => l.trim())}>
            {(line) => {
              // First whitespace-delimited token is the short SHA.
              const sha = line.trim().split(/\s+/)[0];
              return (
                <button
                  class="ws-commit-row"
                  title="View this commit's diff"
                  onClick={() => sha && openCommitInCenter(props.workspace, sha)}
                >
                  {line}
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function DiffView(props: { workspace: string; path?: string }) {
  const [diff] = createResource(
    () => [props.workspace, props.path] as const,
    async ([ws, path]) => {
      try {
        const res = await send({ type: "get_workspace_diff", workspace: ws, path });
        return res.type === "workspace_diff" ? res.diff : "";
      } catch {
        return "";
      }
    },
  );
  return (
    <div class="ws-diff-view">
      <Show when={!diff.loading} fallback={<div class="empty-state">Loading diff…</div>}>
        <Show when={(diff() ?? "").trim()} fallback={<div class="empty-state">No diff</div>}>
          <Diff text={diff()!} defaultLang={props.path ? langFromPath(props.path) : undefined} />
        </Show>
      </Show>
    </div>
  );
}

export default function ChangesTab(props: { workspace: string }) {
  // The diff below renders all three scopes (working tree / unstaged / staged),
  // so the summary rows default to "all" for a consistent picture. The
  // right-panel ChangesRows keeps its own default independently.
  return (
    <div class="ws-changes-tab">
      <ChangesRows workspace={props.workspace} defaultScope="all" showCommits />
      <DiffView workspace={props.workspace} />
    </div>
  );
}
