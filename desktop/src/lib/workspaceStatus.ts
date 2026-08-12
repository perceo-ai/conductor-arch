// Pure workspace status → indicator mapping for the sidebar dot (conductor-style
// status glyph). Kept dependency-free and structural so it is unit-testable and
// does not couple to the full WorkspaceRow store type.

export type WorkspaceStatusKind = "archived" | "running" | "review" | "changes" | "idle";

export interface WorkspaceStatusInput {
  status?: string; // "active" | "archived" | …
  runRunning?: boolean;
  activeSessions?: number;
  prNumber?: number;
  prState?: string;
  changedFiles?: number;
  openTodos?: number;
}

// Precedence: archived first, then live work (running), then an open PR under
// review, then uncommitted changes, else idle. First match wins.
export function workspaceStatusKind(w: WorkspaceStatusInput): WorkspaceStatusKind {
  if (w.status === "archived") return "archived";
  if (w.runRunning || (w.activeSessions ?? 0) > 0) return "running";
  if (w.prNumber != null && (w.prState ?? "").toLowerCase() === "open") return "review";
  if ((w.changedFiles ?? 0) > 0) return "changes";
  return "idle";
}

export const STATUS_COLOR: Record<WorkspaceStatusKind, string> = {
  running: "#3fb27f", // green — active session / run
  review: "#5b8def", // blue — open PR
  changes: "#c39b50", // amber — uncommitted changes
  idle: "#6a6a6a", // grey — nothing in flight
  archived: "#4a4a4a", // dim — archived
};

export const STATUS_LABEL: Record<WorkspaceStatusKind, string> = {
  running: "Running",
  review: "In review",
  changes: "Has changes",
  idle: "Idle",
  archived: "Archived",
};

export type DashboardTriageBadgeTone = "agent" | "run" | "pr" | "changes" | "todo";

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
