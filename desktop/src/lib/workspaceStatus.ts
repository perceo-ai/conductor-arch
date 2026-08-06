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
