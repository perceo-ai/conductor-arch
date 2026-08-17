// Pure workspace status → indicator mapping for the sidebar dot (conductor-style
// status glyph). Kept dependency-free and structural so it is unit-testable and
// does not couple to the full WorkspaceRow store type.

export type WorkspaceStatusKind =
  | "archived"
  | "blocked"
  | "running"
  | "review"
  | "changes"
  | "idle";

export interface WorkspaceStatusInput {
  status?: string; // "active" | "archived" | …
  branch?: string;
  runRunning?: boolean;
  activeSessions?: number;
  prNumber?: number;
  prState?: string;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  openTodos?: number;
  openTasks?: number;
  blockedTasks?: number;
}

// Precedence: archived first, then a blocked task (it needs a human), then live
// work (running), then an open PR under review, then uncommitted changes, else
// idle. First match wins.
export function workspaceStatusKind(w: WorkspaceStatusInput): WorkspaceStatusKind {
  if (w.status === "archived") return "archived";
  if ((w.blockedTasks ?? 0) > 0) return "blocked";
  if (w.runRunning || (w.activeSessions ?? 0) > 0) return "running";
  if (w.prNumber != null && (w.prState ?? "").toLowerCase() === "open") return "review";
  if ((w.changedFiles ?? 0) > 0) return "changes";
  return "idle";
}

export const STATUS_COLOR: Record<WorkspaceStatusKind, string> = {
  blocked: "#d97706", // orange — a task is blocked and needs a human
  running: "#3fb27f", // green — active session / run
  review: "#5b8def", // blue — open PR
  changes: "#c39b50", // amber — uncommitted changes
  idle: "#6a6a6a", // grey — nothing in flight
  archived: "#4a4a4a", // dim — archived
};

export const STATUS_LABEL: Record<WorkspaceStatusKind, string> = {
  blocked: "Blocked",
  running: "Running",
  review: "In review",
  changes: "Has changes",
  idle: "Idle",
  archived: "Archived",
};

export type DashboardTriageBadgeTone = "agent" | "run" | "pr" | "changes" | "todo" | "task";

export interface DashboardTriageBadge {
  tone: DashboardTriageBadgeTone;
  label: string;
  title: string;
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

export function dashboardTriageBadges(w: WorkspaceStatusInput): DashboardTriageBadge[] {
  const activeAgents = w.activeSessions ?? 0;
  const changedFiles = w.changedFiles ?? 0;
  const openTodos = w.openTodos ?? 0;
  const badges: DashboardTriageBadge[] = [
    {
      tone: "agent",
      label: activeAgents > 0 ? plural(activeAgents, "agent") : "No agents",
      title:
        activeAgents > 0
          ? `${plural(activeAgents, "active agent session")}`
          : "No active agent sessions",
    },
    {
      tone: "run",
      label: w.runRunning ? "Run live" : "Run idle",
      title: w.runRunning ? "Run script is running" : "No run script is running",
    },
  ];

  const openTasks = w.openTasks ?? 0;
  const blockedTasks = w.blockedTasks ?? 0;
  if (openTasks > 0 || blockedTasks > 0) {
    badges.push({
      tone: "task",
      label: blockedTasks > 0 ? `${blockedTasks} blocked` : plural(openTasks, "task"),
      title:
        blockedTasks > 0
          ? `${plural(blockedTasks, "blocked task")} of ${plural(openTasks, "open task")}`
          : plural(openTasks, "open task"),
    });
  }

  if (w.prNumber != null) {
    const state = (w.prState ?? "").trim();
    badges.push({
      tone: "pr",
      label: state ? `PR #${w.prNumber} ${state}` : `PR #${w.prNumber}`,
      title: state
        ? `Pull request #${w.prNumber} is ${state}`
        : `Pull request #${w.prNumber}`,
    });
  }

  badges.push(
    {
      tone: "changes",
      label: changedFiles > 0 ? plural(changedFiles, "file") : "Clean",
      title: changedFiles > 0 ? plural(changedFiles, "changed file") : "No changed files",
    },
    {
      tone: "todo",
      label: openTodos > 0 ? plural(openTodos, "todo", "todos") : "No todos",
      title: openTodos > 0 ? plural(openTodos, "open todo", "open todos") : "No open todos",
    },
  );

  return badges;
}

export function workspaceSidebarMeta(w: WorkspaceStatusInput): string {
  const branch = (w.branch ?? "").trim();
  const additions = w.additions ?? 0;
  const deletions = w.deletions ?? 0;
  const parts: string[] = [];

  if (branch) parts.push(branch);
  if (additions > 0 || deletions > 0) parts.push(`+${additions} -${deletions}`);
  if (parts.length === 0) parts.push(w.status ?? "active");

  return parts.join(" · ");
}
