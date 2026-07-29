import { For, Show, createResource, createSignal } from "solid-js";
import { send } from "@/bridge/client";
import type { DiffFileSummary, WorkspaceChangeScope } from "@/bridge/protocol";

// Changes views — port of workspace_changes_panel + workspace_diff_sections.
// The right panel shows the summary rows; the main Changes tab shows rows plus
// the three-section unified diff. Both fetch on demand via createResource.

function countsText(f: DiffFileSummary): string {
  return f.additions != null && f.deletions != null ? `+${f.additions} -${f.deletions}` : "binary";
}

function stateLabel(f: DiffFileSummary): string {
  if (f.untracked) return "[untracked]";
  if (f.staged && f.unstaged) return "[staged+unstaged]";
  if (f.staged) return "[staged]";
  if (f.unstaged) return "[unstaged]";
  return "[clean]";
}

function ChangeRow(props: { file: DiffFileSummary; showState: boolean }) {
  return (
    <div class="ws-file-summary-row-content">
      <span class="ws-file-icon">·</span>
      <span class="ws-file-name">{props.file.path}</span>
      <Show when={props.showState}>
        <span class="ws-file-summary-state">{stateLabel(props.file)}</span>
      </Show>
      <span class="ws-file-summary-counts">{countsText(props.file)}</span>
    </div>
  );
}

export function ChangesRows(props: { workspace: string; defaultScope?: WorkspaceChangeScope }) {
  const [scope, setScope] = createSignal<WorkspaceChangeScope>(props.defaultScope ?? "uncommitted");
  const [changes] = createResource(
    () => [props.workspace, scope()] as const,
    async ([ws, sc]) => {
      try {
        const res = await send({ type: "get_workspace_changes", workspace: ws, scope: sc });
        return res.type === "workspace_changes" ? res.files : [];
      } catch {
        return [];
      }
    },
  );
  return (
    <div class="ws-file-summary-panel">
      <div class="ws-changes-header">
        <span class="ws-changes-title">Changes</span>
        <div class="ws-changes-scope">
          <button
            class="nav-button"
            classList={{ "nav-button-active": scope() === "uncommitted" }}
            onClick={() => setScope("uncommitted")}
          >
            Uncommitted
          </button>
          <button
            class="nav-button"
            classList={{ "nav-button-active": scope() === "all" }}
            onClick={() => setScope("all")}
          >
            All
          </button>
        </div>
      </div>
      <Show
        when={(changes() ?? []).length > 0}
        fallback={<div class="empty-state">{changes.loading ? "Loading…" : "No changes"}</div>}
      >
        <For each={changes()}>
          {(file) => <ChangeRow file={file} showState={scope() === "uncommitted"} />}
        </For>
      </Show>
    </div>
  );
}

export function DiffView(props: { workspace: string }) {
  const [diff] = createResource(
    () => props.workspace,
    async (ws) => {
      try {
        const res = await send({ type: "get_workspace_diff", workspace: ws });
        return res.type === "workspace_diff" ? res.diff : "";
      } catch {
        return "";
      }
    },
  );
  return (
    <div class="ws-diff-view">
      <Show when={!diff.loading} fallback={<div class="empty-state">Loading diff…</div>}>
        <pre class="ws-diff-text">{diff()}</pre>
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
      <ChangesRows workspace={props.workspace} defaultScope="all" />
      <DiffView workspace={props.workspace} />
    </div>
  );
}
