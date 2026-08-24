import type { RepositoryRow } from "@/store/repositories";
import type { WorkspaceRow } from "@/store/workspaces";

export function WorkspacePeek(_props: { row: WorkspaceRow }) {
  const row = _props.row;
  const state = row.awaitingInput ? "Needs input" : row.status === "archived" ? "Archived" : "Active";
  return (
    <div class="peek-content peek-workspace-content">
      <div class="peek-eyebrow">{row.repository}</div>
      <div class="peek-title-row">
        <strong>{row.name}</strong>
        <span class="peek-state">{state}</span>
      </div>
      <div class="peek-branch">{row.branch}</div>
      <dl class="peek-facts">
        <div>
          <dt>Changes</dt>
          <dd>
            {row.changedFiles} changed {row.changedFiles === 1 ? "file" : "files"}
            <span class="peek-diff-add">+{row.additions}</span>
            <span class="peek-diff-delete">−{row.deletions}</span>
          </dd>
        </div>
        <div>
          <dt>Agents</dt>
          <dd>{row.activeSessions} {row.activeSessions === 1 ? "agent" : "agents"}</dd>
        </div>
        <div>
          <dt>Tasks</dt>
          <dd>
            {row.openTasks} open
            {row.blockedTasks > 0
              ? ` · ${row.blockedTasks} blocked ${row.blockedTasks === 1 ? "task" : "tasks"}`
              : ""}
          </dd>
        </div>
        <div>
          <dt>Pull request</dt>
          <dd>{row.prNumber ? `PR #${row.prNumber} · ${row.prState ?? "open"}` : "None"}</dd>
        </div>
      </dl>
    </div>
  );
}

export function RepositoryPeek(_props: { row: RepositoryRow }) {
  const row = _props.row;
  return (
    <div class="peek-content peek-repository-content">
      <div class="peek-eyebrow">Project</div>
      <div class="peek-title-row"><strong>{row.name}</strong></div>
      <dl class="peek-facts">
        <div><dt>Default branch</dt><dd>{row.defaultBranch}</dd></div>
        <div><dt>Workspaces</dt><dd>{row.activeWorkspaces} active · {row.totalWorkspaces} total</dd></div>
        <div><dt>Remote</dt><dd>{row.remoteName}</dd></div>
      </dl>
      <div class="peek-path">{row.rootPath}</div>
    </div>
  );
}
