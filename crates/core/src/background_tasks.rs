//! Background development tasks.
//!
//! A background task is the API/CLI/MCP entry point from the UX strategy:
//! create a workspace from a prompt, let an agent work in it, then prepare the
//! review — run checks, write the workspace summary, and optionally open a
//! pull request. It is deliberately scoped to development branches; this is not
//! a general automation engine.
//!
//! The state machine is driven by `advance_background_task`, which the archcar
//! daemon ticks. Every transition is idempotent enough to re-run after a
//! restart, since the daemon may die mid-flight.

use anyhow::{Context, Result};
use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};

use crate::workspace::{timestamp, ProcessStatus, WorkspaceStore};

/// Lifecycle of a background task. Terminal states: `ready`, `failed`,
/// `cancelled`.
pub const BACKGROUND_TASK_STATUSES: [&str; 8] = [
    "pending",
    "running",
    "checking",
    "summarizing",
    "opening_pr",
    "ready",
    "failed",
    "cancelled",
];

pub fn background_task_is_terminal(status: &str) -> bool {
    matches!(status, "ready" | "failed" | "cancelled")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackgroundTask {
    pub id: i64,
    pub repository_name: String,
    pub workspace_name: Option<String>,
    pub task_id: Option<i64>,
    pub title: String,
    pub prompt: String,
    pub provider: String,
    pub status: String,
    pub run_checks: bool,
    pub open_pr: bool,
    pub draft_pr: bool,
    /// Human-readable progress note for the current status.
    pub detail: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartBackgroundTask {
    pub repository: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    /// Agent provider to run the prompt with (codex, claude, …).
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Run the repository's configured checks once the agent goes idle.
    #[serde(default = "default_true")]
    pub run_checks: bool,
    /// Commit, push, and open a pull request when the work settles.
    #[serde(default)]
    pub open_pr: bool,
    /// Open the pull request as a draft. Biased on, since PR is the review
    /// handoff and not an autonomous merge.
    #[serde(default = "default_true")]
    pub draft_pr: bool,
}

fn default_provider() -> String {
    "codex".to_owned()
}

fn default_true() -> bool {
    true
}

const COLUMNS: &str = "id, repository_name, workspace_name, task_id, title, prompt, provider, \
     status, run_checks, open_pr, draft_pr, detail, error, created_at, updated_at";

fn row_to_background_task(row: &Row<'_>) -> rusqlite::Result<BackgroundTask> {
    Ok(BackgroundTask {
        id: row.get(0)?,
        repository_name: row.get(1)?,
        workspace_name: row.get(2)?,
        task_id: row.get(3)?,
        title: row.get(4)?,
        prompt: row.get(5)?,
        provider: row.get(6)?,
        status: row.get(7)?,
        run_checks: row.get::<_, i64>(8)? != 0,
        open_pr: row.get::<_, i64>(9)? != 0,
        draft_pr: row.get::<_, i64>(10)? != 0,
        detail: row.get(11)?,
        error: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

/// First line of the prompt, trimmed to a workable task title.
pub fn title_from_prompt(prompt: &str) -> String {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Background task");
    let mut title: String = line.chars().take(72).collect();
    if line.chars().count() > 72 {
        title.push('…');
    }
    title
}

impl WorkspaceStore {
    /// Create the workspace and the tracking rows for a background task. The
    /// agent session itself is spawned by the daemon, which owns processes.
    pub fn start_background_task(&self, input: StartBackgroundTask) -> Result<BackgroundTask> {
        let prompt = input.prompt.trim();
        anyhow::ensure!(!prompt.is_empty(), "background task prompt is required");
        // Background work needs a harness that accepts a queued prompt and
        // reports when it is done; a raw shell cannot do either.
        anyhow::ensure!(
            matches!(input.provider.as_str(), "codex" | "claude"),
            "background tasks need a managed agent provider (codex or claude), got `{}`",
            input.provider
        );
        let title = input
            .title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| title_from_prompt(prompt));

        let workspace = self.create_from_prompt(
            &input.repository,
            prompt,
            input.workspace_name.as_deref(),
            input.branch.as_deref(),
            input.base_ref.as_deref(),
        )?;
        let task = self.create_task(&workspace.name, &title, prompt, &[])?;
        self.update_task(
            task.id,
            crate::workspace_intel::TaskUpdate {
                status: Some("in_progress".to_owned()),
                ..Default::default()
            },
        )?;

        let now = timestamp();
        self.conn.execute(
            "INSERT INTO background_tasks (
                repository_id, repository_name, workspace_id, workspace_name, task_id, title,
                prompt, provider, status, run_checks, open_pr, draft_pr, detail, created_at, updated_at
             ) VALUES (
                (SELECT repository_id FROM workspaces WHERE id = ?1), ?2, ?1, ?3, ?4, ?5,
                ?6, ?7, 'pending', ?8, ?9, ?10, 'Waiting for the agent session to start', ?11, ?11
             )",
            params![
                workspace.id,
                input.repository,
                workspace.name,
                task.id,
                title,
                prompt,
                input.provider,
                i64::from(input.run_checks),
                i64::from(input.open_pr),
                i64::from(input.draft_pr),
                now,
            ],
        )?;
        let background = self.get_background_task(self.conn.last_insert_rowid())?;
        self.record_workspace_event(
            workspace.id,
            &workspace.name,
            "background_task.created",
            &format!("Background task #{} created: {}", background.id, title),
        )?;
        Ok(background)
    }

    pub fn get_background_task(&self, id: i64) -> Result<BackgroundTask> {
        self.conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM background_tasks WHERE id = ?1"),
                [id],
                row_to_background_task,
            )
            .with_context(|| format!("load background task {id}"))
    }

    pub fn list_background_tasks(&self, active_only: bool) -> Result<Vec<BackgroundTask>> {
        let sql = if active_only {
            format!(
                "SELECT {COLUMNS} FROM background_tasks
                 WHERE status NOT IN ('ready', 'failed', 'cancelled') ORDER BY id"
            )
        } else {
            format!("SELECT {COLUMNS} FROM background_tasks ORDER BY id")
        };
        let mut stmt = self.conn.prepare(&sql)?;
        let tasks = stmt
            .query_map([], row_to_background_task)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(tasks)
    }

    pub fn cancel_background_task(&self, id: i64) -> Result<BackgroundTask> {
        let task = self.get_background_task(id)?;
        anyhow::ensure!(
            !background_task_is_terminal(&task.status),
            "background task {id} already finished ({})",
            task.status
        );
        self.set_background_task_status(id, "cancelled", "Cancelled by request")?;
        self.get_background_task(id)
    }

    /// Mark the agent session as started, so the supervisor stops waiting for
    /// a spawn and starts watching for the session to go idle.
    pub fn mark_background_task_running(&self, id: i64) -> Result<BackgroundTask> {
        self.set_background_task_status(id, "running", "Agent session running")?;
        self.get_background_task(id)
    }

    /// Advance one background task by one step. `agent_active` is whether the
    /// workspace still has a live agent session; the daemon supplies it because
    /// process liveness lives with the session runtime.
    ///
    /// Returns the task after the step. Non-terminal statuses are safe to call
    /// repeatedly.
    pub fn advance_background_task(&self, id: i64, agent_active: bool) -> Result<BackgroundTask> {
        let task = self.get_background_task(id)?;
        if background_task_is_terminal(&task.status) {
            return Ok(task);
        }
        let Some(workspace) = task.workspace_name.clone() else {
            self.fail_background_task(id, "background task has no workspace")?;
            return self.get_background_task(id);
        };

        let step = match task.status.as_str() {
            // Still waiting on the agent: nothing to do until it settles.
            "pending" | "running" if agent_active => return Ok(task),
            "pending" | "running" => self.begin_background_checks(&task, &workspace),
            "checking" => self.finish_background_checks(&task, &workspace),
            "summarizing" => self.write_background_summary(&task, &workspace),
            "opening_pr" => self.open_background_pull_request(&task, &workspace),
            other => Err(anyhow::anyhow!("unknown background task status `{other}`")),
        };

        match step {
            Ok(()) => {}
            Err(err) => {
                self.fail_background_task(id, &format!("{err:#}"))?;
            }
        }
        self.get_background_task(id)
    }

    fn begin_background_checks(&self, task: &BackgroundTask, workspace: &str) -> Result<()> {
        if !task.run_checks {
            return self.set_background_task_status(
                task.id,
                "summarizing",
                "Checks skipped by request",
            );
        }
        let checks = self.list_workspace_checks(workspace).unwrap_or_default();
        if checks.is_empty() {
            return self.set_background_task_status(
                task.id,
                "summarizing",
                "No checks configured for this repository",
            );
        }
        let mut started = Vec::new();
        for check in &checks {
            match self.run_workspace_check(workspace, &check.key) {
                Ok(_) => started.push(check.key.clone()),
                // A check that cannot start should not sink the whole task; the
                // summary records what did run.
                Err(err) => started.push(format!("{} (failed to start: {err})", check.key)),
            }
        }
        self.set_background_task_status(
            task.id,
            "checking",
            &format!("Running checks: {}", started.join(", ")),
        )
    }

    fn finish_background_checks(&self, task: &BackgroundTask, workspace: &str) -> Result<()> {
        let running = self
            .list_checks(workspace)?
            .into_iter()
            .filter(|process| process.status == ProcessStatus::Running)
            .count();
        if running > 0 {
            return self.set_background_task_status(
                task.id,
                "checking",
                &format!("Waiting on {running} running check(s)"),
            );
        }
        self.set_background_task_status(task.id, "summarizing", "Checks finished")
    }

    fn write_background_summary(&self, task: &BackgroundTask, workspace: &str) -> Result<()> {
        let body = self.draft_workspace_summary(workspace)?;
        self.save_summary(
            workspace,
            "workspace",
            None,
            &body,
            &[format!("background task #{}", task.id)],
        )?;
        if let Some(task_id) = task.task_id {
            // The agent is done with the task even if a human still has to review.
            let _ = self.update_task(
                task_id,
                crate::workspace_intel::TaskUpdate {
                    status: Some("review".to_owned()),
                    ..Default::default()
                },
            );
        }
        if task.open_pr {
            self.set_background_task_status(task.id, "opening_pr", "Preparing pull request")
        } else {
            self.set_background_task_status(
                task.id,
                "ready",
                "Ready for review (no pull request requested)",
            )
        }
    }

    fn open_background_pull_request(&self, task: &BackgroundTask, workspace: &str) -> Result<()> {
        // Commit whatever the agent left behind so the PR has content, then
        // push. Both are no-ops when the agent already committed/pushed.
        if !self.changed_files(workspace).unwrap_or_default().is_empty() {
            let message = self
                .commit_message_draft(workspace)
                .unwrap_or_else(|_| task.title.clone());
            self.stage_all_workspace_files(workspace)?;
            self.commit_workspace_changes(workspace, &message)?;
        }
        self.push_branch(workspace)?;
        let (title, body) = self.draft_pull_request(workspace)?;
        let output =
            self.create_pull_request(workspace, Some(&title), Some(&body), task.draft_pr)?;
        self.set_background_task_status(
            task.id,
            "ready",
            &format!("Pull request ready: {}", output.trim()),
        )
    }

    /// Whether the workspace still has a live agent session process.
    pub fn workspace_has_active_agent(&self, workspace_name: &str) -> Result<bool> {
        let workspace = self.get_by_name(workspace_name)?;
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM processes
              WHERE workspace_id = ?1 AND kind = 'session' AND status = 'running'",
            [workspace.id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Whether a workspace still has chat input queued for an agent. A prompt
    /// that has not been delivered yet means the work has not started.
    pub fn workspace_has_queued_chat_input(&self, workspace_name: &str) -> Result<bool> {
        let workspace = self.get_by_name(workspace_name)?;
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM chat_queued_inputs q
               JOIN chat_threads t ON t.id = q.thread_id
              WHERE t.workspace_id = ?1",
            [workspace.id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Advance every non-terminal background task once, deciding "is the agent
    /// still working?" with the caller's predicate. The archcar daemon passes
    /// live session runtime state, which is the only place that truth exists:
    /// a managed session's process stays alive between turns, so process
    /// liveness alone would keep every task pinned at `running` forever.
    pub fn tick_background_tasks_with(
        &self,
        agent_active: impl Fn(&str) -> bool,
    ) -> Result<Vec<BackgroundTask>> {
        let mut advanced = Vec::new();
        for task in self.list_background_tasks(true)? {
            let active = task
                .workspace_name
                .as_deref()
                .map(|workspace| {
                    self.workspace_has_queued_chat_input(workspace)
                        .unwrap_or(false)
                        || agent_active(workspace)
                })
                .unwrap_or(false);
            advanced.push(self.advance_background_task(task.id, active)?);
        }
        Ok(advanced)
    }

    /// Tick using only database state. Correct for a stopped/exited session;
    /// callers with live session state should use `tick_background_tasks_with`.
    pub fn tick_background_tasks(&self) -> Result<Vec<BackgroundTask>> {
        self.tick_background_tasks_with(|workspace| {
            self.workspace_has_active_agent(workspace).unwrap_or(false)
        })
    }

    /// Record that a background task could not proceed, with the reason. The
    /// supervisor skips terminal tasks, so a failed start does not spin.
    pub fn mark_background_task_failed(&self, id: i64, error: &str) -> Result<BackgroundTask> {
        self.fail_background_task(id, error)?;
        self.get_background_task(id)
    }

    fn fail_background_task(&self, id: i64, error: &str) -> Result<()> {
        let now = timestamp();
        self.conn.execute(
            "UPDATE background_tasks SET status = 'failed', error = ?1, updated_at = ?2
              WHERE id = ?3",
            params![error, now, id],
        )?;
        Ok(())
    }

    fn set_background_task_status(&self, id: i64, status: &str, detail: &str) -> Result<()> {
        debug_assert!(BACKGROUND_TASK_STATUSES.contains(&status));
        let now = timestamp();
        self.conn.execute(
            "UPDATE background_tasks SET status = ?1, detail = ?2, updated_at = ?3 WHERE id = ?4",
            params![status, detail, now, id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::{AddRepository, RepositoryStore};
    use std::path::PathBuf;
    use std::process::Command;

    fn init_repo(path: PathBuf) -> PathBuf {
        std::fs::create_dir_all(&path).unwrap();
        Command::new("git")
            .args(["init", "--initial-branch", "main"])
            .arg(&path)
            .status()
            .unwrap();
        std::fs::write(path.join("README.md"), "demo\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(["add", "."])
            .status()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&path)
            .args([
                "-c",
                "user.name=Archductor",
                "-c",
                "user.email=archductor@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "initial",
            ])
            .status()
            .unwrap();
        path
    }

    fn store(temp: &tempfile::TempDir) -> WorkspaceStore {
        let repo_path = init_repo(temp.path().join("demo"));
        let db_path = temp.path().join("state.db");
        RepositoryStore::open(&db_path)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo_path,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(temp.path().join("workspaces/demo")),
            })
            .unwrap();
        WorkspaceStore::open(&db_path).unwrap()
    }

    fn start(store: &WorkspaceStore, open_pr: bool) -> BackgroundTask {
        store
            .start_background_task(StartBackgroundTask {
                repository: "demo".to_owned(),
                prompt: "Add a Context tab to the right panel".to_owned(),
                title: None,
                workspace_name: Some("berlin".to_owned()),
                branch: Some("lc/berlin".to_owned()),
                base_ref: Some("main".to_owned()),
                provider: "codex".to_owned(),
                run_checks: true,
                open_pr,
                draft_pr: true,
            })
            .unwrap()
    }

    #[test]
    fn starting_a_background_task_creates_a_workspace_and_an_in_progress_task() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);

        let background = start(&store, false);
        assert_eq!(background.status, "pending");
        assert_eq!(background.workspace_name.as_deref(), Some("berlin"));
        assert_eq!(background.title, "Add a Context tab to the right panel");

        let tasks = store.list_tasks("berlin").unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, "in_progress");
        assert_eq!(background.task_id, Some(tasks[0].id));
    }

    #[test]
    fn unmanaged_providers_are_rejected_before_a_workspace_is_created() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let err = store
            .start_background_task(StartBackgroundTask {
                repository: "demo".to_owned(),
                prompt: "do the thing".to_owned(),
                title: None,
                workspace_name: Some("oslo".to_owned()),
                branch: None,
                base_ref: None,
                provider: "shell".to_owned(),
                run_checks: true,
                open_pr: false,
                draft_pr: true,
            })
            .unwrap_err();
        assert!(err.to_string().contains("managed agent provider"), "{err}");
        assert!(store.list_background_tasks(false).unwrap().is_empty());
    }

    #[test]
    fn an_active_agent_holds_the_task_in_place() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let background = start(&store, false);

        let held = store.advance_background_task(background.id, true).unwrap();
        assert_eq!(held.status, "pending");
    }

    #[test]
    fn an_idle_agent_advances_through_checks_and_summary_to_ready() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let background = start(&store, false);

        // No checks are configured in the bare fixture repository, so the task
        // goes straight to summarizing.
        let after_checks = store.advance_background_task(background.id, false).unwrap();
        assert_eq!(after_checks.status, "summarizing", "{after_checks:?}");

        let ready = store.advance_background_task(background.id, false).unwrap();
        assert_eq!(ready.status, "ready", "{ready:?}");
        assert!(ready.detail.contains("no pull request"), "{ready:?}");

        // The summary is stored so the workspace can be picked up cold.
        let summary = store
            .get_summary("berlin", "workspace", None)
            .unwrap()
            .expect("workspace summary");
        assert!(summary.body_markdown.contains("## Next actions"));

        // The task is handed to review rather than silently closed.
        let tasks = store.list_tasks("berlin").unwrap();
        assert_eq!(tasks[0].status, "review");

        // Terminal tasks stay put.
        let again = store.advance_background_task(background.id, false).unwrap();
        assert_eq!(again.status, "ready");
    }

    #[test]
    fn ticking_advances_every_active_task_and_skips_finished_ones() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let background = start(&store, false);

        // No live agent process exists, so a tick moves the task forward.
        let ticked = store.tick_background_tasks().unwrap();
        assert_eq!(ticked.len(), 1);
        assert_eq!(ticked[0].status, "summarizing");
        assert!(!store.workspace_has_active_agent("berlin").unwrap());

        store.tick_background_tasks().unwrap();
        assert_eq!(
            store.get_background_task(background.id).unwrap().status,
            "ready"
        );
        assert!(store.tick_background_tasks().unwrap().is_empty());
    }

    #[test]
    fn cancelling_stops_the_state_machine() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let background = start(&store, false);

        let cancelled = store.cancel_background_task(background.id).unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(
            store
                .advance_background_task(background.id, false)
                .unwrap()
                .status,
            "cancelled"
        );
        assert!(store.cancel_background_task(background.id).is_err());
        assert!(store.list_background_tasks(true).unwrap().is_empty());
        assert_eq!(store.list_background_tasks(false).unwrap().len(), 1);
    }

    #[test]
    fn opening_a_pull_request_without_a_remote_fails_the_task_with_the_reason() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let background = start(&store, true);

        store.advance_background_task(background.id, false).unwrap(); // → summarizing
        let opening = store.advance_background_task(background.id, false).unwrap();
        assert_eq!(opening.status, "opening_pr", "{opening:?}");

        // The fixture repo has no remote, so the push fails and the task
        // records why instead of hanging.
        let failed = store.advance_background_task(background.id, false).unwrap();
        assert_eq!(failed.status, "failed", "{failed:?}");
        assert!(failed.error.is_some(), "{failed:?}");
    }
}
