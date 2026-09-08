import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { send } from "@/bridge/client";
import { commitScopeSha, type DiffFileSummary, type WorkspaceChangeScope } from "@/bridge/protocol";
import CompactSelect, { type CompactSelectOption } from "@/components/CompactSelect";
import Diff from "@/components/Diff";
import Icon from "@/components/Icon";
import { parseCommitLog, shortSha } from "@/lib/commitLog";
import { langFromPath } from "@/lib/highlight";
import { materialFileIcon } from "@/lib/materialFileIcons";
import { openCommitInCenter, openFileInCenter } from "./openFileBridge";

// Changes views. The scope selector picks which set of changes the panel lists
// — everything since the review base, uncommitted work, or one commit — and the
// same scope travels with a file when it is opened, so the file's diff shows
// that scope's changes rather than everything since the base.

const ALL_SCOPE = "all";
const UNCOMMITTED_SCOPE = "uncommitted";
const COMMIT_PREFIX = "commit:";

/** Encode a scope as a CompactSelect option value. */
function scopeToValue(scope: WorkspaceChangeScope): string {
  const sha = commitScopeSha(scope);
  return sha ? `${COMMIT_PREFIX}${sha}` : scope === "all" ? ALL_SCOPE : UNCOMMITTED_SCOPE;
}

function valueToScope(value: string): WorkspaceChangeScope {
  if (value.startsWith(COMMIT_PREFIX)) {
    return { commit: { sha: value.slice(COMMIT_PREFIX.length) } };
  }
  return value === ALL_SCOPE ? "all" : "uncommitted";
}

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

function ChangeRow(props: {
  file: DiffFileSummary;
  onOpen?: (path: string) => void;
}) {
  const icon = () => materialFileIcon(props.file.path);
  return (
    <button
      class="ws-file-row ws-change-row"
      onClick={() => props.onOpen?.(props.file.path)}
    >
      <img
        class="ws-material-icon ws-file-kind-icon"
        src={icon().src}
        title={icon().title}
        alt=""
        loading="lazy"
      />
      <span class="ws-file-name">{props.file.path}</span>
      <Counts file={props.file} />
    </button>
  );
}

export function ChangesRows(props: {
  workspace: string;
  defaultScope?: WorkspaceChangeScope;
  openFile?: (path: string, scope: WorkspaceChangeScope) => void;
}) {
  const [scope, setScope] = createSignal<WorkspaceChangeScope>(props.defaultScope ?? "uncommitted");

  const [changes] = createResource(
    () => [props.workspace, scopeToValue(scope())] as const,
    async ([ws]) => {
      try {
        const res = await send({ type: "get_workspace_changes", workspace: ws, scope: scope() });
        return res.type === "workspace_changes" ? res.files : [];
      } catch {
        return [];
      }
    },
  );

  const [commits] = createResource(
    () => props.workspace,
    async (ws) => {
      try {
        const res = await send({ type: "get_recent_commits", workspace: ws, limit: 15 });
        return res.type === "recent_commits" ? parseCommitLog(res.log) : [];
      } catch {
        return [];
      }
    },
  );

  const options = createMemo<CompactSelectOption[]>(() => [
    { value: ALL_SCOPE, label: "All changes" },
    { value: UNCOMMITTED_SCOPE, label: "Uncommitted" },
    ...(commits() ?? []).map((commit) => ({
      value: `${COMMIT_PREFIX}${commit.sha}`,
      label: `${shortSha(commit.sha)} ${commit.subject}`.trim(),
      group: "Recent commits",
    })),
  ]);

  return (
    <div class="ws-file-summary-panel">
      <div class="ws-changes-header">
        <span class="ws-changes-title">Changes</span>
        <CompactSelect
          class="ws-changes-scope"
          placement="down"
          title="Which changes to list"
          value={scopeToValue(scope())}
          options={options()}
          onChange={(value) => {
            const next = valueToScope(value);
            setScope(next);
          }}
        />
        {/* The scope list replaced the old recent-commits rows, which were the
            only way to open a whole commit's diff. Keep that reachable. */}
        <Show when={commitScopeSha(scope())}>
          {(sha) => (
            <button
              class="ws-changes-commit-open"
              title="Open the full commit diff"
              onClick={() => openCommitInCenter(props.workspace, sha())}
            >
              <Icon name="git-compare" />
            </button>
          )}
        </Show>
      </div>
      <div class="ws-file-list ws-change-list">
        <Show
          when={(changes() ?? []).length > 0}
          fallback={<div class="empty-state">{changes.loading ? "Loading…" : "No changes"}</div>}
        >
          <For each={changes()}>
            {(file) => (
              <ChangeRow
                file={file}
                onOpen={(path) => props.openFile?.(path, scope())}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

export function DiffView(props: {
  workspace: string;
  path?: string;
  scope?: WorkspaceChangeScope;
}) {
  const [diff] = createResource(
    () => [props.workspace, props.path, scopeToValue(props.scope ?? "all")] as const,
    async ([ws, path]) => {
      try {
        const res = await send({
          type: "get_workspace_diff",
          workspace: ws,
          path,
          scope: props.scope ?? "all",
        });
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
  return (
    <div class="ws-changes-tab">
      <ChangesRows
        workspace={props.workspace}
        defaultScope="all"
        openFile={(path, scope) => openFileInCenter(props.workspace, path, scope)}
      />
    </div>
  );
}
