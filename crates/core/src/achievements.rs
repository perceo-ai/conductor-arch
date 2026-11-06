//! Achievements and workspace-name discovery.
//!
//! This is a deliberately cheap, read-only feature: every number it shows is
//! derived on demand from rows the daemon already writes (workspaces,
//! processes, chat threads, provider events), so nothing has to be tracked or
//! kept in sync as the app runs. Each metric is one `COUNT`-shaped query; the
//! whole summary is a few dozen of them behind a single RPC that only runs
//! when a human opens the page. Slow is acceptable here, extra bookkeeping is
//! not.
//!
//! The shape of the catalog — five tiers, categories, hidden "secret" entries
//! that only appear once there is a first signal — follows the
//! `hermes-achievements` dashboard plugin, so the two feel like the same kind
//! of thing.
//!
//! The one piece of real state is [`crate::workspace::WorkspaceStore::record_workspace_name_discovery`],
//! written when a workspace is created, so a generated name stays discovered
//! after that workspace is archived or discarded.

use std::collections::BTreeMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::workspace::{workspace_name_pool, WorkspaceStore};

/// Tier ladder, lowest first. Mirrors the hermes-achievements ladder.
pub const TIER_NAMES: [&str; 5] = ["Copper", "Silver", "Gold", "Diamond", "Olympian"];

/// How an achievement's metric accumulates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AchievementKind {
    /// Counts over the whole history of this daemon.
    Lifetime,
    /// The best single session/thread, not the sum.
    BestSession,
}

/// One catalog entry. Ids are the stable keys: renaming one silently resets
/// how a client remembers it, so treat them as wire format.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AchievementDef {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    /// What the metric actually counts, shown as the card's "what counts" line.
    pub counts: &'static str,
    pub metric: &'static str,
    pub kind: AchievementKind,
    pub tiers: [i64; 5],
    /// Hidden until the metric moves at all.
    pub secret: bool,
}

/// An evaluated catalog entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AchievementProgress {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub counts: String,
    pub metric: String,
    pub kind: AchievementKind,
    /// Current metric value.
    pub value: i64,
    /// Highest tier earned, 1-based; `None` when nothing is earned yet.
    pub tier: Option<u8>,
    pub tier_name: Option<String>,
    /// Threshold of the next tier, `None` once the top tier is earned.
    pub next_threshold: Option<i64>,
    pub tier_thresholds: Vec<i64>,
    pub secret: bool,
    /// Whether a surface may show this entry, for clients that cannot call
    /// [`AchievementProgress::is_revealed`]. Defaulted because a remote daemon
    /// older than this field does not send it.
    #[serde(default)]
    pub revealed: bool,
}

impl AchievementProgress {
    pub fn unlocked(&self) -> bool {
        self.tier.is_some()
    }

    /// Whether a surface may show this entry at all. Read from `secret` and
    /// `tier`, not the `revealed` field, so it also holds for an older daemon.
    pub fn is_revealed(&self) -> bool {
        reveals(self.secret, self.tier)
    }
}

/// The one reveal rule, shared by the CLI and the desktop page: a secret stays
/// hidden until its first tier is earned. Seeing "Permission Denied Any%"
/// before it happens spoils the joke.
fn reveals(secret: bool, tier: Option<u8>) -> bool {
    !secret || tier.is_some()
}

/// One generated workspace name and whether it has ever been used here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredName {
    pub name: String,
    pub discovered: bool,
}

/// The "which names have I seen?" collection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoverySummary {
    pub total: usize,
    pub discovered: usize,
    pub names: Vec<DiscoveredName>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AchievementsSummary {
    pub achievements: Vec<AchievementProgress>,
    pub discovery: DiscoverySummary,
    /// Raw metric values, so a client can show the numbers without a second
    /// round trip.
    pub metrics: BTreeMap<String, i64>,
    /// Count of catalog entries with at least one tier.
    pub unlocked: usize,
    /// Sum of earned tiers across the catalog — the single "score" number.
    pub tiers_earned: usize,
    pub total: usize,
}

macro_rules! ach {
    (
        $id:literal, $name:literal, $category:literal, $description:literal,
        $counts:literal, $metric:literal, [$($tier:literal),+ $(,)?]
    ) => {
        AchievementDef {
            id: $id,
            name: $name,
            description: $description,
            category: $category,
            counts: $counts,
            metric: $metric,
            kind: AchievementKind::Lifetime,
            tiers: [$($tier),+],
            secret: false,
        }
    };
}

/// The catalog. Thresholds are tuned for a single developer's machine rather
/// than for a fleet: the Copper tier should land in the first week of real use
/// and Olympian should stay out of reach for a long while.
pub fn catalog() -> Vec<AchievementDef> {
    let mut all = vec![
        // --- Workspaces ---
        ach!(
            "worktree_wrangler",
            "Worktree Wrangler",
            "Workspaces",
            "Spin up isolated workspaces like they are free. They nearly are.",
            "Workspaces created, including archived and discarded ones.",
            "workspaces_created",
            [5, 25, 100, 400, 1500]
        ),
        ach!(
            "parallel_universe",
            "Parallel Universe",
            "Workspaces",
            "Keep more than one agent's world alive at the same time.",
            "Workspaces that currently exist and are not archived.",
            "workspaces_active",
            [3, 6, 10, 20, 40]
        ),
        ach!(
            "clean_desk_policy",
            "Clean Desk Policy",
            "Workspaces",
            "Actually archive the work instead of letting worktrees pile up.",
            "Workspaces archived.",
            "workspaces_archived",
            [5, 25, 100, 400, 1500]
        ),
        ach!(
            "project_collector",
            "Project Collector",
            "Workspaces",
            "Point Archductor at more than one repository.",
            "Distinct repositories registered.",
            "repositories",
            [2, 4, 8, 16, 32]
        ),
        ach!(
            "cartographer",
            "Cartographer",
            "Workspaces",
            "Discover the generated workspace names, one distro at a time.",
            "Distinct generated workspace names ever used on this machine.",
            "names_discovered",
            [10, 40, 100, 160, 200]
        ),
        // --- Agent Autonomy ---
        ach!(
            "let_it_cook",
            "Let It Cook",
            "Agent Autonomy",
            "Hand an agent a real task and let the turn run.",
            "Agent sessions started across every workspace.",
            "sessions_started",
            [25, 100, 500, 2000, 8000]
        ),
        ach!(
            "one_long_leash",
            "One Long Leash",
            "Agent Autonomy",
            "A single chat thread that kept going well past the point of a quick question.",
            "Most tool events recorded in one chat thread.",
            "max_tool_events_in_thread",
            [50, 200, 600, 1500, 4000]
        ),
        ach!(
            "toolchain_maxxer",
            "Toolchain Maxxer",
            "Agent Autonomy",
            "Let agents reach for tools instead of guessing.",
            "Tool-call events across every provider.",
            "tool_events",
            [500, 2500, 10000, 40000, 150000]
        ),
        ach!(
            "subagent_commander",
            "Subagent Commander",
            "Agent Autonomy",
            "Delegate. Supervise. Take the credit.",
            "Subagent and collaboration events.",
            "subagent_events",
            [10, 50, 200, 800, 3000]
        ),
        ach!(
            "mcp_plumber",
            "MCP Plumber",
            "Agent Autonomy",
            "Wire agents into tools that live outside the harness.",
            "MCP events.",
            "mcp_events",
            [25, 150, 600, 2500, 10000]
        ),
        ach!(
            "skill_issue_resolved",
            "Skill Issue, Resolved",
            "Agent Autonomy",
            "Push work into skills, plugins and hooks instead of repeating yourself.",
            "Skill, plugin and hook events.",
            "skill_events",
            [10, 60, 250, 1000, 4000]
        ),
        // --- Vibe Coding ---
        ach!(
            "one_more_small_change",
            "One More Small Change",
            "Vibe Coding",
            "Make enough edits in one place to retire the phrase \"small change\".",
            "File-change events recorded by providers.",
            "file_change_events",
            [100, 600, 2500, 10000, 40000]
        ),
        ach!(
            "supposed_to_be_quick",
            "This Was Supposed To Be Quick",
            "Vibe Coding",
            "One thread that turned into an expedition.",
            "Most messages in a single chat thread.",
            "max_messages_in_thread",
            [100, 300, 800, 2000, 5000]
        ),
        ach!(
            "thread_hoarder",
            "Thread Hoarder",
            "Vibe Coding",
            "Start conversations faster than you finish them.",
            "Chat threads created.",
            "chat_threads",
            [25, 100, 500, 2000, 8000]
        ),
        ach!(
            "prompt_mileage",
            "Prompt Mileage",
            "Vibe Coding",
            "Type at the machine. A lot.",
            "Messages you sent, across every thread.",
            "user_messages",
            [100, 750, 3000, 12000, 50000]
        ),
        ach!(
            "checkpoint_believer",
            "Checkpoint Believer",
            "Vibe Coding",
            "Trust the undo button enough to make one.",
            "Checkpoints recorded.",
            "checkpoints",
            [10, 50, 250, 1000, 4000]
        ),
        // --- Shipping ---
        ach!(
            "pull_request_pipeline",
            "Pull Request Pipeline",
            "Shipping",
            "Turn worktrees into something a human can review.",
            "Pull requests opened from a workspace.",
            "prs_opened",
            [1, 10, 50, 200, 800]
        ),
        ach!(
            "merge_merchant",
            "Merge Merchant",
            "Shipping",
            "Land it. Shipping beats branching.",
            "Pull requests recorded as merged.",
            "prs_merged",
            [1, 10, 50, 200, 800]
        ),
        ach!(
            "green_check_ritual",
            "Green Check Ritual",
            "Shipping",
            "Run the checks before claiming it works.",
            "Workspace check runs.",
            "checks_run",
            [10, 75, 400, 1500, 6000]
        ),
        ach!(
            "review_in_the_margins",
            "Review In The Margins",
            "Shipping",
            "Leave notes on the diff instead of in your head.",
            "Review comments stored.",
            "review_comments",
            [5, 40, 200, 800, 3000]
        ),
        ach!(
            "run_it_locally",
            "Run It Locally",
            "Shipping",
            "Boot the thing you just changed.",
            "Workspace run commands started.",
            "runs_started",
            [10, 75, 400, 1500, 6000]
        ),
        // --- Tool Mastery ---
        ach!(
            "terminal_goblin",
            "Terminal Goblin",
            "Tool Mastery",
            "Shell-land is home now.",
            "Terminal sessions opened in a workspace.",
            "terminals_opened",
            [10, 75, 400, 1500, 6000]
        ),
        ach!(
            "command_cascade",
            "Command Cascade",
            "Tool Mastery",
            "Commands and processes, launched on your behalf.",
            "Command and process events.",
            "command_events",
            [250, 1500, 6000, 25000, 100000]
        ),
        ach!(
            "rabbit_hole_certified",
            "Rabbit Hole Certified",
            "Tool Mastery",
            "Research spiral: web search, fetch, repeat.",
            "Web, browser and media events.",
            "web_events",
            [50, 300, 1200, 5000, 20000]
        ),
        ach!(
            "thinking_out_loud",
            "Thinking Out Loud",
            "Tool Mastery",
            "Let the agent reason where you can read it.",
            "Planning and reasoning events.",
            "reasoning_events",
            [200, 1200, 5000, 20000, 80000]
        ),
        ach!(
            "task_in_the_background",
            "Task In The Background",
            "Tool Mastery",
            "Work that keeps going after you look away.",
            "Background tasks recorded.",
            "background_tasks",
            [5, 30, 150, 600, 2500]
        ),
        // --- Model Lore ---
        ach!(
            "provider_polyglot",
            "Provider Polyglot",
            "Model Lore",
            "Do not marry the first agent that answers.",
            "Distinct providers seen in provider events.",
            "distinct_providers",
            [2, 3, 4, 6, 8]
        ),
        ach!(
            "model_sommelier",
            "Model Sommelier",
            "Model Lore",
            "Taste enough models to have opinions about them.",
            "Distinct models recorded on chat threads.",
            "distinct_models",
            [2, 5, 10, 20, 40]
        ),
        // --- Lifestyle ---
        ach!(
            "marathon_operator",
            "Marathon Operator",
            "Lifestyle",
            "One session that outlasted a working day.",
            "Longest single session, in minutes.",
            "longest_session_minutes",
            [60, 180, 480, 720, 1440]
        ),
        ach!(
            "weekend_warrior",
            "Weekend Warrior",
            "Lifestyle",
            "Saturday is a great day to refactor.",
            "Sessions started on a Saturday or Sunday, local time.",
            "weekend_sessions",
            [10, 50, 200, 800, 3000]
        ),
        ach!(
            "night_shift",
            "Night Shift",
            "Lifestyle",
            "Gremlin hours. The agents do not mind.",
            "Sessions started between midnight and 5am, local time.",
            "night_sessions",
            [10, 50, 200, 800, 3000]
        ),
        ach!(
            "summary_reader",
            "Summary Reader",
            "Lifestyle",
            "Let the workspace explain itself to the next you.",
            "Workspace summaries generated.",
            "summaries",
            [5, 40, 200, 800, 3000]
        ),
    ];

    // Secret entries: hidden until the metric moves, because every one of them
    // is a thing that went wrong.
    all.extend([
        AchievementDef {
            id: "permission_denied_any_percent",
            name: "Permission Denied Any%",
            description: "Speedrun into permission walls.",
            category: "Debugging Chaos",
            counts: "Approval and permission prompts raised by agents.",
            metric: "permission_events",
            kind: AchievementKind::Lifetime,
            tiers: [10, 75, 300, 1200, 5000],
            secret: true,
        },
        AchievementDef {
            id: "red_text_connoisseur",
            name: "Red Text Connoisseur",
            description: "Enough failures to develop a palate for red text.",
            category: "Debugging Chaos",
            counts: "Limit and failure events from providers.",
            metric: "failure_events",
            kind: AchievementKind::Lifetime,
            tiers: [10, 75, 300, 1200, 5000],
            secret: true,
        },
        AchievementDef {
            id: "it_died_again",
            name: "It Died Again",
            description: "Processes that did not make it to the end.",
            category: "Debugging Chaos",
            counts: "Processes that exited with a failing exit code.",
            metric: "failed_processes",
            kind: AchievementKind::Lifetime,
            tiers: [5, 40, 200, 800, 3000],
            secret: true,
        },
        AchievementDef {
            id: "worktree_cemetery",
            name: "Worktree Cemetery",
            description: "Some workspaces never reach a branch worth keeping.",
            category: "Debugging Chaos",
            counts: "Workspaces whose last recorded status is a failure.",
            metric: "failed_workspaces",
            kind: AchievementKind::Lifetime,
            tiers: [1, 5, 20, 75, 300],
            secret: true,
        },
    ]);

    for def in &mut all {
        if def.metric.starts_with("max_") {
            def.kind = AchievementKind::BestSession;
        }
    }
    all
}

/// Evaluate one catalog entry against collected metrics.
fn evaluate(def: &AchievementDef, metrics: &BTreeMap<String, i64>) -> AchievementProgress {
    let value = metrics.get(def.metric).copied().unwrap_or(0);
    // Tiers are ascending, so the earned tier is the count of thresholds met.
    let earned = def
        .tiers
        .iter()
        .filter(|threshold| value >= **threshold)
        .count();
    let tier = (earned > 0).then_some(earned as u8);
    AchievementProgress {
        id: def.id.to_owned(),
        name: def.name.to_owned(),
        description: def.description.to_owned(),
        category: def.category.to_owned(),
        counts: def.counts.to_owned(),
        metric: def.metric.to_owned(),
        kind: def.kind,
        value,
        tier,
        tier_name: tier.map(|index| TIER_NAMES[usize::from(index) - 1].to_owned()),
        next_threshold: def.tiers.get(earned).copied(),
        tier_thresholds: def.tiers.to_vec(),
        secret: def.secret,
        revealed: reveals(def.secret, tier),
    }
}

/// Build the whole summary from already-collected metrics and discovered names.
/// Split out from the queries so the evaluation is testable without a database.
pub fn summarize(
    metrics: BTreeMap<String, i64>,
    discovered: &std::collections::BTreeSet<String>,
) -> AchievementsSummary {
    let achievements: Vec<AchievementProgress> = catalog()
        .iter()
        .map(|def| evaluate(def, &metrics))
        .collect();
    let unlocked = achievements.iter().filter(|entry| entry.unlocked()).count();
    let tiers_earned = achievements
        .iter()
        .map(|entry| usize::from(entry.tier.unwrap_or(0)))
        .sum();
    let total = achievements.len();

    let pool = workspace_name_pool();
    let names: Vec<DiscoveredName> = pool
        .iter()
        .map(|name| DiscoveredName {
            name: (*name).to_owned(),
            discovered: discovered.contains(*name),
        })
        .collect();
    let discovery = DiscoverySummary {
        total: names.len(),
        discovered: names.iter().filter(|entry| entry.discovered).count(),
        names,
    };

    AchievementsSummary {
        achievements,
        discovery,
        metrics,
        unlocked,
        tiers_earned,
        total,
    }
}

/// Every metric the catalog can reference, as one SQL scalar query each.
///
/// Deliberately one query per metric: it is the readable shape, it runs only
/// when a human opens the page, and a query against a table an older database
/// does not have degrades to 0 instead of failing the whole summary.
const METRIC_QUERIES: &[(&str, &str)] = &[
    ("workspaces_created", "SELECT COUNT(*) FROM workspaces"),
    (
        "workspaces_active",
        "SELECT COUNT(*) FROM workspaces WHERE status <> 'archived'",
    ),
    (
        "workspaces_archived",
        "SELECT COUNT(*) FROM workspaces WHERE status = 'archived'",
    ),
    (
        "failed_workspaces",
        "SELECT COUNT(*) FROM workspaces WHERE status LIKE '%failed%'",
    ),
    ("repositories", "SELECT COUNT(*) FROM repositories"),
    (
        "sessions_started",
        "SELECT COUNT(*) FROM processes WHERE kind = 'session'",
    ),
    (
        "runs_started",
        "SELECT COUNT(*) FROM processes WHERE kind = 'run'",
    ),
    (
        "checks_run",
        "SELECT COUNT(*) FROM processes WHERE kind = 'check'",
    ),
    (
        "terminals_opened",
        "SELECT COUNT(*) FROM processes WHERE kind = 'terminal'",
    ),
    (
        "failed_processes",
        "SELECT COUNT(*) FROM processes WHERE status = 'exited' AND exit_code <> 0",
    ),
    // `started_at` is epoch seconds stored as TEXT, so every date function has
    // to be told that with 'unixepoch'; 'localtime' is what makes "weekend"
    // and "night" mean what the human sitting here would call them.
    (
        "weekend_sessions",
        "SELECT COUNT(*) FROM processes WHERE kind = 'session'
           AND CAST(strftime('%w', started_at, 'unixepoch', 'localtime') AS INTEGER) IN (0, 6)",
    ),
    (
        "night_sessions",
        "SELECT COUNT(*) FROM processes WHERE kind = 'session'
           AND CAST(strftime('%H', started_at, 'unixepoch', 'localtime') AS INTEGER) < 5",
    ),
    (
        "longest_session_minutes",
        "SELECT COALESCE(MAX((CAST(ended_at AS INTEGER) - CAST(started_at AS INTEGER)) / 60), 0)
           FROM processes WHERE kind = 'session' AND ended_at IS NOT NULL",
    ),
    ("chat_threads", "SELECT COUNT(*) FROM chat_threads"),
    (
        "user_messages",
        "SELECT COUNT(*) FROM chat_messages WHERE role = 'user'",
    ),
    (
        "max_messages_in_thread",
        "SELECT COALESCE(MAX(total), 0) FROM
           (SELECT COUNT(*) AS total FROM chat_messages GROUP BY thread_id)",
    ),
    (
        "distinct_models",
        "SELECT COUNT(DISTINCT model) FROM chat_threads WHERE model IS NOT NULL AND model <> ''",
    ),
    (
        "distinct_providers",
        "SELECT COUNT(DISTINCT provider) FROM provider_events",
    ),
    (
        "tool_events",
        "SELECT COUNT(*) FROM provider_events WHERE kind = 'tool'",
    ),
    (
        "max_tool_events_in_thread",
        "SELECT COALESCE(MAX(total), 0) FROM
           (SELECT COUNT(*) AS total FROM provider_events
              WHERE kind = 'tool' AND chat_thread_id IS NOT NULL GROUP BY chat_thread_id)",
    ),
    (
        "mcp_events",
        "SELECT COUNT(*) FROM provider_events WHERE kind = 'mcp'",
    ),
    (
        "skill_events",
        "SELECT COUNT(*) FROM provider_events WHERE kind = 'skill_plugin_hook'",
    ),
    (
        "subagent_events",
        "SELECT COUNT(*) FROM provider_events WHERE kind = 'subagent_collaboration'",
    ),
    (
        "web_events",
        "SELECT COUNT(*) FROM provider_events WHERE kind = 'web_browser_media'",
    ),
    (
        "command_events",
        "SELECT COUNT(*) FROM provider_events WHERE kind = 'command_process'",
    ),
    (
        "file_change_events",
        "SELECT COUNT(*) FROM provider_events WHERE kind = 'diff_file_change'",
    ),
    (
        "reasoning_events",
        "SELECT COUNT(*) FROM provider_events WHERE kind = 'planning_reasoning'",
    ),
    (
        "permission_events",
        "SELECT COUNT(*) FROM provider_events WHERE kind = 'approval_permission'",
    ),
    (
        "failure_events",
        "SELECT COUNT(*) FROM provider_events WHERE kind = 'limit_failure'",
    ),
    ("prs_opened", "SELECT COUNT(*) FROM pull_requests"),
    (
        "prs_merged",
        "SELECT COUNT(*) FROM pull_requests WHERE LOWER(state) = 'merged'",
    ),
    ("review_comments", "SELECT COUNT(*) FROM review_comments"),
    ("checkpoints", "SELECT COUNT(*) FROM checkpoints"),
    ("summaries", "SELECT COUNT(*) FROM summaries"),
    ("background_tasks", "SELECT COUNT(*) FROM background_tasks"),
];

impl WorkspaceStore {
    /// Collected metrics for the achievements page. Public so the CLI and tests
    /// can show the raw numbers without the catalog on top.
    pub fn achievement_metrics(&self) -> BTreeMap<String, i64> {
        let mut metrics = BTreeMap::new();
        for (name, sql) in METRIC_QUERIES {
            let value = self
                .conn
                .query_row(sql, [], |row| row.get::<_, i64>(0))
                .unwrap_or(0);
            metrics.insert((*name).to_owned(), value);
        }
        let discovered = self.discovered_workspace_names().unwrap_or_default();
        metrics.insert("names_discovered".to_owned(), discovered.len() as i64);
        metrics
    }

    /// Everything the achievements surface needs, in one pass.
    pub fn achievements_summary(&self) -> Result<AchievementsSummary> {
        let metrics = self.achievement_metrics();
        let discovered = self.discovered_workspace_names()?;
        Ok(summarize(metrics, &discovered))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    use rusqlite::params;

    fn store() -> (tempfile::TempDir, WorkspaceStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::open(temp.path().join("workspace.db")).unwrap();
        (temp, store)
    }

    /// Epoch seconds, as TEXT, for a wall-clock time in the machine's own
    /// timezone — the format `processes.started_at` actually uses. Computed by
    /// SQLite's own 'utc' modifier so the weekend/night assertions do not
    /// depend on where the test runs.
    fn local_epoch(store: &WorkspaceStore, local: &str) -> String {
        store
            .conn
            .query_row(
                "SELECT CAST(strftime('%s', ?1, 'utc') AS TEXT)",
                params![local],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
    }

    fn insert_workspace(store: &WorkspaceStore, name: &str) -> i64 {
        store
            .conn
            .execute(
                "INSERT INTO repositories
                   (name, root_path, default_branch, workspace_parent_path, created_at, updated_at)
                 VALUES ('repo', ?1, 'main', ?1, '0', '0')
                 ON CONFLICT(root_path) DO NOTHING",
                params![format!("/tmp/{name}-repo")],
            )
            .unwrap();
        let repository_id: i64 = store
            .conn
            .query_row("SELECT id FROM repositories LIMIT 1", [], |row| row.get(0))
            .unwrap();
        store
            .conn
            .execute(
                "INSERT INTO workspaces
                   (repository_id, name, path, branch, base_ref, port_base, status,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?2, 'main', 42000, 'ready', '0', '0')",
                params![repository_id, name, format!("/tmp/{name}")],
            )
            .unwrap();
        store.conn.last_insert_rowid()
    }

    fn insert_session(store: &WorkspaceStore, workspace_id: i64, started_at: &str, ended_at: &str) {
        store
            .conn
            .execute(
                "INSERT INTO processes
                   (workspace_id, kind, command, pid, log_path, status, started_at, ended_at)
                 VALUES (?1, 'session', 'agent', 1, '/tmp/log', 'exited', ?2, ?3)",
                params![workspace_id, started_at, ended_at],
            )
            .unwrap();
    }

    fn insert_process(
        store: &WorkspaceStore,
        workspace_id: i64,
        status: &str,
        exit_code: Option<i32>,
    ) {
        store
            .conn
            .execute(
                "INSERT INTO processes
                   (workspace_id, kind, command, pid, log_path, status, started_at, exit_code)
                 VALUES (?1, 'run', 'make', 1, '/tmp/log', ?2, '0', ?3)",
                params![workspace_id, status, exit_code],
            )
            .unwrap();
    }

    #[test]
    fn every_metric_query_runs_against_the_real_schema() {
        let (_temp, store) = store();
        for (name, sql) in METRIC_QUERIES {
            store
                .conn
                .query_row(sql, [], |row| row.get::<_, i64>(0))
                .unwrap_or_else(|err| panic!("metric {name} query failed: {err}\n{sql}"));
        }
    }

    #[test]
    fn an_empty_database_reads_as_all_zeroes_rather_than_failing() {
        let (_temp, store) = store();
        let summary = store.achievements_summary().unwrap();
        assert_eq!(summary.unlocked, 0);
        assert_eq!(summary.tiers_earned, 0);
        assert_eq!(summary.discovery.discovered, 0);
        assert_eq!(summary.discovery.total, workspace_name_pool().len());
        assert!(summary.metrics.values().all(|value| *value == 0));
    }

    #[test]
    fn discovered_names_survive_the_workspace_that_earned_them() {
        let (_temp, store) = store();
        let pool_name = workspace_name_pool()[7];
        store.record_workspace_name_discovery(pool_name).unwrap();
        // Recording twice must not double-count.
        store.record_workspace_name_discovery(pool_name).unwrap();

        let summary = store.achievements_summary().unwrap();
        assert_eq!(summary.discovery.discovered, 1);
        assert_eq!(summary.metrics["names_discovered"], 1);
        assert!(
            summary
                .discovery
                .names
                .iter()
                .find(|entry| entry.name == pool_name)
                .unwrap()
                .discovered
        );
    }

    #[test]
    fn existing_workspaces_count_as_discovered_without_a_recorded_row() {
        let (_temp, store) = store();
        let pool_name = workspace_name_pool()[3];
        insert_workspace(&store, pool_name);

        let discovered = store.discovered_workspace_names().unwrap();
        assert!(discovered.contains(pool_name));
    }

    #[test]
    fn failed_processes_counts_exited_rows_with_a_failing_exit_code() {
        let (_temp, store) = store();
        let workspace_id = insert_workspace(&store, "nixos");
        insert_process(&store, workspace_id, "exited", Some(1));
        insert_process(&store, workspace_id, "exited", Some(137));
        // None of these failed: a clean exit, an exit with no code to judge
        // (daemon restart, lost child), a deliberate SIGTERM stop, a live row.
        insert_process(&store, workspace_id, "exited", Some(0));
        insert_process(&store, workspace_id, "exited", None);
        insert_process(&store, workspace_id, "stopped", Some(143));
        insert_process(&store, workspace_id, "running", None);

        assert_eq!(store.achievement_metrics()["failed_processes"], 2);
    }

    #[test]
    fn custom_workspace_names_do_not_feed_cartographer() {
        let (_temp, store) = store();
        for index in 0..10 {
            let name = format!("my-custom-name-{index}");
            insert_workspace(&store, &name);
            store.record_workspace_name_discovery(&name).unwrap();
        }

        let summary = store.achievements_summary().unwrap();
        assert_eq!(summary.discovery.discovered, 0);
        assert_eq!(summary.metrics["names_discovered"], 0);
        let cartographer = summary
            .achievements
            .iter()
            .find(|entry| entry.id == "cartographer")
            .unwrap();
        assert_eq!(cartographer.tier, None);
    }

    #[test]
    fn upgrading_backfills_discoveries_so_they_outlive_the_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("workspace.db");
        let pool_name = workspace_name_pool()[11];
        // A database from before discoveries were recorded: live workspace
        // rows and nothing in the table, which is what every v0.14.0 install
        // has for its older workspaces.
        let (pool_id, custom_id) = {
            let store = WorkspaceStore::open(&path).unwrap();
            (
                insert_workspace(&store, pool_name),
                insert_workspace(&store, "my-custom-name"),
            )
        };

        let store = WorkspaceStore::open(&path).unwrap();
        for id in [pool_id, custom_id] {
            store
                .conn
                .execute("DELETE FROM workspaces WHERE id = ?1", [id])
                .unwrap();
        }

        let discovered = store.discovered_workspace_names().unwrap();
        assert!(discovered.contains(pool_name));
        assert_eq!(discovered.len(), 1, "custom names are not discoveries");
    }

    #[test]
    fn session_metrics_read_epoch_seconds_in_local_time() {
        let (_temp, store) = store();
        let workspace_id = insert_workspace(&store, "nixos");
        // Saturday 02:00 local: weekend and night at once.
        let saturday_night = local_epoch(&store, "2026-11-07 02:00:00");
        let saturday_night_end = local_epoch(&store, "2026-11-07 05:30:00");
        insert_session(&store, workspace_id, &saturday_night, &saturday_night_end);
        // Wednesday 14:00 local: neither.
        let weekday_afternoon = local_epoch(&store, "2026-11-04 14:00:00");
        let weekday_afternoon_end = local_epoch(&store, "2026-11-04 14:10:00");
        insert_session(
            &store,
            workspace_id,
            &weekday_afternoon,
            &weekday_afternoon_end,
        );

        let metrics = store.achievement_metrics();
        assert_eq!(metrics["sessions_started"], 2);
        assert_eq!(metrics["weekend_sessions"], 1);
        assert_eq!(metrics["night_sessions"], 1);
        assert_eq!(metrics["longest_session_minutes"], 210);
        assert_eq!(metrics["workspaces_created"], 1);
        assert_eq!(metrics["workspaces_active"], 1);
    }

    fn metrics(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), *value))
            .collect()
    }

    #[test]
    fn catalog_ids_are_unique_and_tiers_ascend() {
        let catalog = catalog();
        let ids: BTreeSet<&str> = catalog.iter().map(|def| def.id).collect();
        assert_eq!(ids.len(), catalog.len(), "duplicate achievement id");
        for def in &catalog {
            assert!(
                def.tiers.windows(2).all(|pair| pair[0] < pair[1]),
                "{} tiers must ascend: {:?}",
                def.id,
                def.tiers
            );
            assert!(def.tiers[0] > 0, "{} Copper tier must be positive", def.id);
        }
    }

    #[test]
    fn every_catalog_metric_is_collected() {
        let collected: BTreeSet<&str> = METRIC_QUERIES
            .iter()
            .map(|(name, _)| *name)
            .chain(std::iter::once("names_discovered"))
            .collect();
        for def in catalog() {
            assert!(
                collected.contains(def.metric),
                "{} references uncollected metric {}",
                def.id,
                def.metric
            );
        }
    }

    #[test]
    fn max_metrics_are_best_session() {
        for def in catalog() {
            let expected = if def.metric.starts_with("max_") {
                AchievementKind::BestSession
            } else {
                AchievementKind::Lifetime
            };
            assert_eq!(def.kind, expected, "{} kind", def.id);
        }
    }

    #[test]
    fn a_secret_is_revealed_by_its_first_tier_and_not_before() {
        let entry = |value| {
            let summary = summarize(
                metrics(&[("permission_events", value)]),
                &Default::default(),
            );
            summary
                .achievements
                .into_iter()
                .find(|entry| entry.id == "permission_denied_any_percent")
                .unwrap()
        };

        for (value, revealed) in [(0, false), (9, false), (10, true)] {
            let entry = entry(value);
            assert_eq!(entry.is_revealed(), revealed, "value {value}");
            assert_eq!(entry.revealed, revealed, "value {value}");
        }
    }

    #[test]
    fn tiers_unlock_in_order_and_report_the_next_threshold() {
        let def = catalog()
            .into_iter()
            .find(|def| def.id == "worktree_wrangler")
            .expect("catalog entry");
        let [copper, silver, ..] = def.tiers;

        let locked = evaluate(&def, &metrics(&[("workspaces_created", copper - 1)]));
        assert_eq!(locked.tier, None);
        assert_eq!(locked.tier_name, None);
        assert_eq!(locked.next_threshold, Some(copper));

        let first = evaluate(&def, &metrics(&[("workspaces_created", copper)]));
        assert_eq!(first.tier, Some(1));
        assert_eq!(first.tier_name.as_deref(), Some("Copper"));
        assert_eq!(first.next_threshold, Some(silver));

        let topped = evaluate(&def, &metrics(&[("workspaces_created", def.tiers[4] * 10)]));
        assert_eq!(topped.tier, Some(5));
        assert_eq!(topped.tier_name.as_deref(), Some("Olympian"));
        assert_eq!(
            topped.next_threshold, None,
            "top tier has no next threshold"
        );
    }

    #[test]
    fn missing_metric_reads_as_zero_rather_than_panicking() {
        let def = catalog().into_iter().next().expect("catalog entry");
        let progress = evaluate(&def, &BTreeMap::new());
        assert_eq!(progress.value, 0);
        assert!(!progress.unlocked());
    }

    #[test]
    fn summary_counts_unlocked_entries_and_earned_tiers() {
        let summary = summarize(
            metrics(&[
                // Copper only.
                ("workspaces_created", 5),
                // Gold: 2, 3, 4 met.
                ("repositories", 8),
            ]),
            &BTreeSet::new(),
        );
        assert_eq!(summary.total, catalog().len());
        assert_eq!(summary.unlocked, 2);
        assert_eq!(summary.tiers_earned, 1 + 3);
    }

    #[test]
    fn discovery_marks_the_whole_name_pool() {
        let pool = workspace_name_pool();
        let discovered: BTreeSet<String> = [pool[0].to_owned(), "not-in-the-pool".to_owned()]
            .into_iter()
            .collect();
        let summary = summarize(metrics(&[("names_discovered", 1)]), &discovered);

        assert_eq!(summary.discovery.total, pool.len());
        assert_eq!(
            summary.discovery.discovered, 1,
            "a name outside the pool must not inflate the count"
        );
        assert!(summary.discovery.names[0].discovered);
        assert!(!summary.discovery.names[1].discovered);
    }
}
