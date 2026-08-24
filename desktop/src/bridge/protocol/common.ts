// Scalars and small shared shapes: session kinds, workflow runs, the skill
// sync plan, and provider summaries.
// TypeScript mirror of crates/core/src/archcar/protocol.rs.
// Keep in sync when the Rust protocol changes. serde uses snake_case + an
// internal `type` tag on the request/response/event enums.

// Open on purpose: the daemon's provider set comes from its registry, so a
// closed union here would drop any agent this build predates. The built-in
// keys are kept for editor completion.
export type SessionKind = "shell" | "codex" | "claude" | (string & {});

/** A GitHub Actions run for a workspace's branch. */
export type WorkflowRun = {
  name: string;
  status: string;
  conclusion: string;
  branch: string;
  url: string;
  started_at: string;
  number: number;
};

export type WorkflowRunSummary = {
  runs: WorkflowRun[];
  failing: number;
  running: number;
  succeeded: number;
  /** Set when gh could not answer (no remote, no auth, not installed). */
  unavailable?: string | null;
};

/** One write a sync would perform. */
export type SyncAction = {
  /** "skill" or "mcp" */
  kind: string;
  item: string;
  provider: string;
  target: string;
  overwrite: boolean;
};

export type SyncPlan = {
  providers: string[];
  /** Providers with a skills directory (Cursor has MCP config but no skills). */
  skill_providers?: string[];
  mcp_providers?: string[];
  /** item name -> providers that already have it */
  skills: Record<string, string[]>;
  mcp_servers: Record<string, string[]>;
  actions: SyncAction[];
};

/** Empty arrays mean "everything", which is what the one-click path sends. */
export type SyncSelection = {
  skills?: string[];
  mcp_servers?: string[];
  providers?: string[];
};

/** A skill installed on the daemon's machine (ListSkills). */
export type AgentSkill = {
  name: string;
  description: string;
  /** Provider keys that have it installed. */
  providers: string[];
  /** Managed by a plugin, so sync leaves it alone. */
  plugin: boolean;
};

/** One agent as the daemon's registry sees it (ListAgentProviders). */
export type AgentProviderSummary = {
  provider_key: string;
  display_name: string;
  default_command: string;
  launchable: boolean;
  managed: boolean;
  /** "full" | "partial" | "basic" | "none" */
  tier: string;
  auth_guidance: string;
};
export type ArchcarInputKind = "user" | "review_prompt" | "control_command" | "raw_terminal";
export type ArchcarInputDelivery = "auto" | "immediate";
export type WorkspaceGitAction = "create_pr" | "push_branch" | "merge_pr" | "open_pr";

