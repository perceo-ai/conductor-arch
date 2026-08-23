//! Workspace intelligence: tasks, operational summaries, and context
//! attachments.
//!
//! These are the branch-local coordination objects from the Archductor UX
//! strategy: a workspace (a branch) holds many tasks, many agent sessions, and
//! operational summaries that make continuation and review possible. They are
//! deliberately *not* durable memory — everything here is scoped to one
//! workspace and dies with it.

use std::collections::{BTreeSet, HashMap};

use anyhow::{Context, Result};
use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};

use crate::workspace::{timestamp, WorkspaceStore};

/// Task lifecycle states. Kept small on purpose: this is lightweight
/// coordination, not enterprise project management.
pub const TASK_STATUSES: [&str; 5] = ["todo", "in_progress", "blocked", "review", "done"];

/// Summary scopes from the strategy doc's data model.
pub const SUMMARY_SCOPES: [&str; 5] = ["workspace", "session", "task", "review", "handoff"];

/// Where a context attachment came from. `archivum` is reserved for the
/// suite-level memory service; Archductor never writes durable memory itself.
pub const CONTEXT_SOURCES: [&str; 2] = ["local", "archivum"];

/// Context attachment shapes.
pub const CONTEXT_KINDS: [&str; 5] = ["note", "summary", "context_pack", "file", "memory"];

/// Marks a summary body as agent prose rather than a mechanical draft. The
/// daemon's auto-refresh treats a body carrying this ref as owned by the agent
/// and leaves it alone.
pub const AGENT_SUMMARY_SOURCE_REF: &str = "archductor:agent";

/// How much agent summary we store. The summary is a handoff note, not a
/// transcript, and it rides back into the next session's context on every
/// staleness prompt — so the ceiling is a budget, not just tidiness.
pub const AGENT_SUMMARY_MAX_CHARS: usize = 1_200;

/// True when this summary body was written by an agent.
pub fn summary_is_agent_authored(summary: &Summary) -> bool {
    summary
        .source_refs
        .iter()
        .any(|source| source == AGENT_SUMMARY_SOURCE_REF)
}

/// Trim agent prose to the stored budget, cutting on a character boundary and
/// dropping a half-written trailing line rather than storing a torn sentence.
fn clamp_agent_summary(body: &str) -> String {
    let body = body.trim();
    if body.chars().count() <= AGENT_SUMMARY_MAX_CHARS {
        return body.to_owned();
    }
    let clamped: String = body.chars().take(AGENT_SUMMARY_MAX_CHARS).collect();
    match clamped.rfind('\n') {
        Some(index) if index > AGENT_SUMMARY_MAX_CHARS / 2 => {
            clamped[..index].trim_end().to_owned()
        }
        _ => clamped.trim_end().to_owned(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: i64,
    pub workspace_id: i64,
    pub title: String,
    pub body: String,
    pub status: String,
    pub owner_session_id: Option<i64>,
    /// Human owner (a name or handle), distinct from the owning agent session.
    pub owner: Option<String>,
    pub intended_areas: Vec<String>,
    pub blocked_reason: Option<String>,
    /// Notes left for/by the reviewer of this task's work.
    pub review_notes: String,
    /// Sessions attached to this task via `chat_threads.task_id`.
    #[serde(default)]
    pub linked_session_ids: Vec<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// Partial task update. `None` leaves the field untouched; `Some(None)` on the
/// nullable fields clears them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_session_id: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intended_areas: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_notes: Option<String>,
}

impl TaskUpdate {
    pub fn is_empty(&self) -> bool {
        self == &TaskUpdate::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Summary {
    pub id: i64,
    pub workspace_id: i64,
    pub scope_type: String,
    pub scope_id: i64,
    pub body_markdown: String,
    pub source_refs: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextAttachment {
    pub id: i64,
    pub workspace_id: i64,
    pub source: String,
    pub kind: String,
    pub body_or_ref: String,
    pub scope: String,
    pub pinned: bool,
    pub created_at: String,
}

/// One agent session's contribution to the branch, for per-agent review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionContribution {
    pub session_id: i64,
    pub title: String,
    pub provider: String,
    /// Explicit model the session was launched with, when recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub status: String,
    pub task_id: Option<i64>,
    pub task_title: Option<String>,
    pub files_touched: Vec<String>,
    /// Files this session touched that still differ from the base ref.
    pub still_present: Vec<String>,
    pub intended_areas: Vec<String>,
    pub summary: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Open/blocked task counts for one workspace.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskCounts {
    pub open: usize,
    pub blocked: usize,
}

/// One command/check/run the daemon executed for a session, from the processes
/// table — the session's first-class run history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRunRecord {
    pub process_id: i64,
    pub kind: String,
    pub command: String,
    pub status: String,
    pub exit_code: Option<i64>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

/// A durable snapshot of one session's diff contribution: the files it
/// touched, the stored patch, and the commands/risks/blockers that came with
/// it. Unlike [`SessionContribution`] (recomputed on read), this survives as
/// first-class provenance for review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffContribution {
    pub id: i64,
    pub workspace_id: i64,
    pub session_id: i64,
    pub files: Vec<String>,
    /// Files still different from the base ref when the snapshot was taken.
    pub still_present: Vec<String>,
    /// Path (relative to the workspace) of the stored patch, when one existed.
    pub patch_ref: Option<String>,
    /// Commands/checks the daemon ran for this session, as `kind: command [status]`.
    pub commands: Vec<String>,
    pub risks: Vec<String>,
    pub blockers: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Which continuously maintained summary to refresh.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SummaryRefreshScope {
    Workspace { workspace: String },
    CurrentChat { workspace: String, thread_id: i64 },
    Task { workspace: String, task_id: i64 },
}

/// The evidence cursor recorded by the last auto-refresh of one summary scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryRefreshState {
    pub id: i64,
    pub workspace_id: i64,
    pub scope_type: String,
    pub scope_id: i64,
    pub source: String,
    pub evidence_hash: String,
    pub latest_message_id: Option<i64>,
    pub latest_provider_sequence: Option<i64>,
    pub last_refreshed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryRefreshResult {
    pub summary: Summary,
    pub state: SummaryRefreshState,
    pub changed: bool,
}

/// One combined markdown briefing for AI clients: workspace summary, current
/// chat, tasks, and next actions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextBriefing {
    pub workspace: String,
    pub thread_id: Option<i64>,
    pub body_markdown: String,
    pub summary_ids: Vec<i64>,
    pub task_ids: Vec<i64>,
}

/// Outcome of extracting native tasks from chat evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskSyncResult {
    pub workspace: String,
    pub thread_id: Option<i64>,
    pub created: usize,
    pub updated: usize,
    pub task_ids: Vec<i64>,
}

/// Two sessions aiming at the same files. Advisory only — Archductor does not
/// lock files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionOverlap {
    pub session_id: i64,
    pub session_title: String,
    pub other_session_id: i64,
    pub other_session_title: String,
    pub paths: Vec<String>,
}

fn join_list(values: &[String]) -> String {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn split_list(value: &str) -> Vec<String> {
    value
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.to_owned())
        .collect()
}

fn validate(value: &str, allowed: &[&str], label: &str) -> Result<String> {
    let value = value.trim().to_ascii_lowercase();
    anyhow::ensure!(
        allowed.contains(&value.as_str()),
        "unknown {label} `{value}` (expected one of {})",
        allowed.join(", ")
    );
    Ok(value)
}

/// Parse a provider `diff_file_change` body — one `<kind> <path>` line per
/// changed file, as written by the Codex app-server adapter.
pub fn parse_file_change_body(body: &str) -> Vec<String> {
    body.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            // Everything after the first word is the path (paths may contain
            // spaces; the change kind never does).
            let path = line.split_once(' ').map(|(_, rest)| rest).unwrap_or(line);
            let path = path.trim();
            (!path.is_empty()).then(|| path.to_owned())
        })
        .collect()
}

/// Present a touched file relative to its workspace when it sits inside it, so
/// per-agent contributions line up with the branch diff's paths.
fn relative_workspace_path(path: &str, workspace_path: &str) -> String {
    let workspace_path = workspace_path.trim_end_matches('/');
    if workspace_path.is_empty() {
        return path.to_owned();
    }
    path.strip_prefix(workspace_path)
        .map(|rest| rest.trim_start_matches('/').to_owned())
        .filter(|rest| !rest.is_empty())
        .unwrap_or_else(|| path.to_owned())
}

fn row_to_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        body: row.get(3)?,
        status: row.get(4)?,
        owner_session_id: row.get(5)?,
        owner: row.get(6)?,
        intended_areas: split_list(&row.get::<_, String>(7)?),
        blocked_reason: row.get(8)?,
        review_notes: row.get(9)?,
        linked_session_ids: Vec::new(),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

const TASK_COLUMNS: &str = "id, workspace_id, title, body, status, owner_session_id, owner, \
     intended_areas, blocked_reason, review_notes, created_at, updated_at";

fn row_to_summary(row: &Row<'_>) -> rusqlite::Result<Summary> {
    Ok(Summary {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        scope_type: row.get(2)?,
        scope_id: row.get(3)?,
        body_markdown: row.get(4)?,
        source_refs: split_list(&row.get::<_, String>(5)?),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

const SUMMARY_COLUMNS: &str =
    "id, workspace_id, scope_type, scope_id, body_markdown, source_refs, created_at, updated_at";

fn row_to_context_attachment(row: &Row<'_>) -> rusqlite::Result<ContextAttachment> {
    Ok(ContextAttachment {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        source: row.get(2)?,
        kind: row.get(3)?,
        body_or_ref: row.get(4)?,
        scope: row.get(5)?,
        pinned: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
    })
}

const CONTEXT_COLUMNS: &str =
    "id, workspace_id, source, kind, body_or_ref, scope, pinned, created_at";

fn row_to_diff_contribution(row: &Row<'_>) -> rusqlite::Result<DiffContribution> {
    Ok(DiffContribution {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        session_id: row.get(2)?,
        files: split_list(&row.get::<_, String>(3)?),
        still_present: split_list(&row.get::<_, String>(4)?),
        patch_ref: row.get(5)?,
        commands: split_list(&row.get::<_, String>(6)?),
        risks: split_list(&row.get::<_, String>(7)?),
        blockers: split_list(&row.get::<_, String>(8)?),
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

const DIFF_CONTRIBUTION_COLUMNS: &str = "id, workspace_id, session_id, files, still_present, \
     patch_ref, commands, risks, blockers, created_at, updated_at";

fn row_to_refresh_state(row: &Row<'_>) -> rusqlite::Result<SummaryRefreshState> {
    Ok(SummaryRefreshState {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        scope_type: row.get(2)?,
        scope_id: row.get(3)?,
        source: row.get(4)?,
        evidence_hash: row.get(5)?,
        latest_message_id: row.get(6)?,
        latest_provider_sequence: row.get(7)?,
        last_refreshed_at: row.get(8)?,
    })
}

const REFRESH_STATE_COLUMNS: &str = "id, workspace_id, scope_type, scope_id, source, \
     evidence_hash, latest_message_id, latest_provider_sequence, last_refreshed_at";

/// Deterministic 64-bit FNV-1a over the refresh evidence. `DefaultHasher` is
/// randomly keyed per process, so it cannot back a cursor that persists in
/// SQLite across daemon restarts.
fn evidence_hash(evidence: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in evidence.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

// ---- Tasks -----------------------------------------------------------------

impl WorkspaceStore {
    pub fn create_task(
        &self,
        workspace_name: &str,
        title: &str,
        body: &str,
        intended_areas: &[String],
    ) -> Result<Task> {
        let title = title.trim();
        anyhow::ensure!(!title.is_empty(), "task title is required");
        let workspace = self.get_by_name(workspace_name)?;
        let now = timestamp();
        self.conn.execute(
            "INSERT INTO tasks (
                workspace_id, title, body, status, intended_areas, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'todo', ?4, ?5, ?6)",
            params![
                workspace.id,
                title,
                body.trim(),
                join_list(intended_areas),
                now,
                now
            ],
        )?;
        let task = self.get_task(self.conn.last_insert_rowid())?;
        self.record_workspace_event(
            workspace.id,
            &workspace.name,
            "task.created",
            &format!("Task #{} created: {}", task.id, task.title),
        )?;
        Ok(task)
    }

    pub fn list_tasks(&self, workspace_name: &str) -> Result<Vec<Task>> {
        let workspace = self.get_by_name(workspace_name)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM tasks WHERE workspace_id = ?1 ORDER BY id"
        ))?;
        let mut tasks = stmt
            .query_map([workspace.id], row_to_task)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for task in &mut tasks {
            task.linked_session_ids = self.task_linked_sessions(task.id)?;
        }
        Ok(tasks)
    }

    /// Sessions attached to a task through `chat_threads.task_id`.
    fn task_linked_sessions(&self, task_id: i64) -> Result<Vec<i64>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM chat_threads WHERE task_id = ?1 ORDER BY id")?;
        let ids = stmt
            .query_map([task_id], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    }

    /// Load a task, refusing one that belongs to a different workspace. Ids are
    /// global primary keys, so every workspace-scoped mutation resolves through
    /// here rather than trusting the id alone.
    pub fn task_in_workspace(&self, workspace_name: &str, id: i64) -> Result<Task> {
        let workspace = self.get_by_name(workspace_name)?;
        let task = self.get_task(id)?;
        anyhow::ensure!(
            task.workspace_id == workspace.id,
            "task {id} not found in workspace {workspace_name}"
        );
        Ok(task)
    }

    pub fn get_task(&self, id: i64) -> Result<Task> {
        let mut task = self
            .conn
            .query_row(
                &format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1"),
                [id],
                row_to_task,
            )
            .with_context(|| format!("load task {id}"))?;
        task.linked_session_ids = self.task_linked_sessions(task.id)?;
        Ok(task)
    }

    pub fn update_task(&self, workspace_name: &str, id: i64, update: TaskUpdate) -> Result<Task> {
        anyhow::ensure!(
            !update.is_empty(),
            "task update requires at least one field"
        );
        let existing = self.task_in_workspace(workspace_name, id)?;

        let title = match update.title {
            Some(ref value) => {
                let value = value.trim();
                anyhow::ensure!(!value.is_empty(), "task title is required");
                value.to_owned()
            }
            None => existing.title.clone(),
        };
        let body = update
            .body
            .as_ref()
            .map(|value| value.trim().to_owned())
            .unwrap_or_else(|| existing.body.clone());
        let status = match update.status {
            Some(ref value) => validate(value, &TASK_STATUSES, "task status")?,
            None => existing.status.clone(),
        };
        let owner_session_id = match update.owner_session_id {
            Some(value) => {
                if let Some(session_id) = value {
                    self.ensure_session_in_workspace(existing.workspace_id, session_id)?;
                }
                value
            }
            None => existing.owner_session_id,
        };
        let owner = match update.owner {
            Some(value) => value.and_then(|owner| {
                let owner = owner.trim().to_owned();
                (!owner.is_empty()).then_some(owner)
            }),
            None => existing.owner.clone(),
        };
        let review_notes = update
            .review_notes
            .as_ref()
            .map(|value| value.trim().to_owned())
            .unwrap_or_else(|| existing.review_notes.clone());
        let intended_areas = update
            .intended_areas
            .as_deref()
            .map(join_list)
            .unwrap_or_else(|| join_list(&existing.intended_areas));
        let blocked_reason = match update.blocked_reason {
            Some(value) => value.and_then(|reason| {
                let reason = reason.trim().to_owned();
                (!reason.is_empty()).then_some(reason)
            }),
            None => existing.blocked_reason.clone(),
        };
        anyhow::ensure!(
            status != "blocked" || blocked_reason.is_some(),
            "blocked tasks require a blocked_reason"
        );

        let now = timestamp();
        self.conn.execute(
            "UPDATE tasks
                SET title = ?1, body = ?2, status = ?3, owner_session_id = ?4, owner = ?5,
                    intended_areas = ?6, blocked_reason = ?7, review_notes = ?8, updated_at = ?9
              WHERE id = ?10",
            params![
                title,
                body,
                status,
                owner_session_id,
                owner,
                intended_areas,
                blocked_reason,
                review_notes,
                now,
                id
            ],
        )?;
        let task = self.get_task(id)?;
        if task.status != existing.status {
            let workspace_name = self.intel_workspace_name(existing.workspace_id)?;
            self.record_workspace_event(
                existing.workspace_id,
                &workspace_name,
                "task.status_changed",
                &format!("Task #{} {} → {}", task.id, existing.status, task.status),
            )?;
        }
        Ok(task)
    }

    pub fn delete_task(&self, workspace_name: &str, id: i64) -> Result<()> {
        let task = self.task_in_workspace(workspace_name, id)?;
        self.conn.execute(
            "UPDATE chat_threads SET task_id = NULL WHERE task_id = ?1",
            [id],
        )?;
        self.conn.execute("DELETE FROM tasks WHERE id = ?1", [id])?;
        self.conn.execute(
            "DELETE FROM summaries WHERE workspace_id = ?1 AND scope_type = 'task' AND scope_id = ?2",
            params![task.workspace_id, id],
        )?;
        Ok(())
    }

    /// Attach an agent session (chat thread) to a task so per-agent diffs and
    /// summaries can be grouped by intent.
    pub fn assign_session_task(
        &self,
        workspace_name: &str,
        session_id: i64,
        task_id: Option<i64>,
    ) -> Result<()> {
        let workspace = self.get_by_name(workspace_name)?;
        self.ensure_session_in_workspace(workspace.id, session_id)?;
        if let Some(task_id) = task_id {
            let task = self.get_task(task_id)?;
            anyhow::ensure!(
                task.workspace_id == workspace.id,
                "task {task_id} belongs to a different workspace than session {session_id}"
            );
        }
        self.conn.execute(
            "UPDATE chat_threads SET task_id = ?1 WHERE id = ?2",
            params![task_id, session_id],
        )?;
        Ok(())
    }

    /// Record the files/areas a session intends to touch, so overlap warnings
    /// can fire before two agents collide.
    pub fn set_session_intended_areas(
        &self,
        workspace_name: &str,
        session_id: i64,
        areas: &[String],
    ) -> Result<()> {
        let workspace = self.get_by_name(workspace_name)?;
        // Scope the write to the named workspace: an id alone is a global key,
        // and a caller must not reach into a workspace it did not name.
        let changed = self.conn.execute(
            "UPDATE chat_threads SET intended_areas = ?1 WHERE id = ?2 AND workspace_id = ?3",
            params![join_list(areas), session_id, workspace.id],
        )?;
        anyhow::ensure!(
            changed > 0,
            "session {session_id} not found in workspace {workspace_name}"
        );
        Ok(())
    }

    fn intel_workspace_name(&self, workspace_id: i64) -> Result<String> {
        self.conn
            .query_row(
                "SELECT name FROM workspaces WHERE id = ?1",
                [workspace_id],
                |row| row.get(0),
            )
            .with_context(|| format!("load workspace name for id {workspace_id}"))
    }

    fn ensure_session_in_workspace(&self, workspace_id: i64, session_id: i64) -> Result<()> {
        let owner: Option<i64> = self
            .conn
            .query_row(
                "SELECT workspace_id FROM chat_threads WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .ok();
        match owner {
            Some(owner) if owner == workspace_id => Ok(()),
            Some(_) => anyhow::bail!("session {session_id} belongs to a different workspace"),
            None => anyhow::bail!("session {session_id} not found"),
        }
    }

    /// Open/blocked task counts per workspace id, for left-rail and dashboard
    /// indicators. One query for every workspace so listing stays cheap.
    pub fn task_counts_by_workspace(&self) -> Result<HashMap<i64, TaskCounts>> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_id,
                    SUM(CASE WHEN status <> 'done' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END)
               FROM tasks GROUP BY workspace_id",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    TaskCounts {
                        open: row.get::<_, i64>(1)?.max(0) as usize,
                        blocked: row.get::<_, i64>(2)?.max(0) as usize,
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().collect())
    }

    // ---- Summaries ---------------------------------------------------------

    pub fn save_summary(
        &self,
        workspace_name: &str,
        scope_type: &str,
        scope_id: Option<i64>,
        body_markdown: &str,
        source_refs: &[String],
    ) -> Result<Summary> {
        let scope_type = validate(scope_type, &SUMMARY_SCOPES, "summary scope")?;
        let scope_id = scope_id.unwrap_or(0);
        anyhow::ensure!(
            scope_type == "workspace" || scope_id != 0,
            "{scope_type} summaries require a scope_id"
        );
        let body_markdown = body_markdown.trim();
        anyhow::ensure!(!body_markdown.is_empty(), "summary body is required");
        let workspace = self.get_by_name(workspace_name)?;
        let now = timestamp();
        self.conn.execute(
            "INSERT INTO summaries (
                workspace_id, scope_type, scope_id, body_markdown, source_refs, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(workspace_id, scope_type, scope_id) DO UPDATE SET
                body_markdown = excluded.body_markdown,
                source_refs = excluded.source_refs,
                updated_at = excluded.updated_at",
            params![
                workspace.id,
                scope_type,
                scope_id,
                body_markdown,
                join_list(source_refs),
                now,
                now
            ],
        )?;
        self.get_summary(workspace_name, &scope_type, Some(scope_id))?
            .context("summary was not stored")
    }

    /// Store the workspace summary an agent wrote for itself and its successors.
    /// Agent prose outranks the mechanical draft: once this exists, the daemon's
    /// auto-refresh stops rewriting the body and only the agent (or a human
    /// editing the tab) changes it.
    pub fn save_agent_workspace_summary(
        &self,
        workspace_name: &str,
        body_markdown: &str,
    ) -> Result<Summary> {
        let body = clamp_agent_summary(body_markdown);
        anyhow::ensure!(!body.is_empty(), "summary body is required");
        self.save_summary(
            workspace_name,
            "workspace",
            None,
            &body,
            &[AGENT_SUMMARY_SOURCE_REF.to_owned()],
        )
    }

    /// The workspace summary an agent should be handed so it edits rather than
    /// rewrites. `None` when nothing durable has been written yet.
    pub fn agent_workspace_summary(&self, workspace_name: &str) -> Result<Option<Summary>> {
        Ok(self
            .get_summary(workspace_name, "workspace", None)?
            .filter(summary_is_agent_authored))
    }

    pub fn get_summary(
        &self,
        workspace_name: &str,
        scope_type: &str,
        scope_id: Option<i64>,
    ) -> Result<Option<Summary>> {
        let scope_type = validate(scope_type, &SUMMARY_SCOPES, "summary scope")?;
        let workspace = self.get_by_name(workspace_name)?;
        let summary = self
            .conn
            .query_row(
                &format!(
                    "SELECT {SUMMARY_COLUMNS} FROM summaries
                     WHERE workspace_id = ?1 AND scope_type = ?2 AND scope_id = ?3"
                ),
                params![workspace.id, scope_type, scope_id.unwrap_or(0)],
                row_to_summary,
            )
            .ok();
        Ok(summary)
    }

    pub fn list_summaries(&self, workspace_name: &str) -> Result<Vec<Summary>> {
        let workspace = self.get_by_name(workspace_name)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {SUMMARY_COLUMNS} FROM summaries WHERE workspace_id = ?1
             ORDER BY scope_type, scope_id"
        ))?;
        let summaries = stmt
            .query_map([workspace.id], row_to_summary)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(summaries)
    }

    pub fn delete_summary(&self, workspace_name: &str, id: i64) -> Result<()> {
        let workspace = self.get_by_name(workspace_name)?;
        let changed = self.conn.execute(
            "DELETE FROM summaries WHERE id = ?1 AND workspace_id = ?2",
            params![id, workspace.id],
        )?;
        anyhow::ensure!(
            changed > 0,
            "summary {id} not found in workspace {workspace_name}"
        );
        Ok(())
    }

    /// Build the branch-local continuity summary: goal, files touched, checks,
    /// blockers, and next actions. This is the seed the Summary tab shows before
    /// an agent has written its own prose, so it deliberately stops at what the
    /// other tabs do not already say — no file lists, no session roster, no check
    /// status, because Changes, Files, and Checks own those.
    pub fn draft_workspace_summary(&self, workspace_name: &str) -> Result<String> {
        let workspace = self.get_by_name(workspace_name)?;
        let checks = self.checks_summary(workspace_name)?;
        let changed = self.changed_files(workspace_name).unwrap_or_default();
        let tasks = self.list_tasks(workspace_name)?;
        let sessions = self.list_chat_threads(workspace_name)?;

        let mut out = String::new();
        out.push_str(&format!("# {} ({})\n\n", workspace.name, workspace.branch));

        out.push_str("## Goal\n\n");
        let goal = tasks
            .iter()
            .find(|task| task.status != "done")
            .map(|task| task.title.clone())
            .or_else(|| {
                sessions
                    .iter()
                    .find(|session| !is_placeholder_chat_title(&session.title))
                    .map(|session| session.title.clone())
            })
            .unwrap_or_else(|| format!("Work on branch {}", workspace.branch));
        out.push_str(&format!("{goal}\n\n"));

        out.push_str("## Blockers\n\n");
        let blocked: Vec<&Task> = tasks
            .iter()
            .filter(|task| task.status == "blocked")
            .collect();
        if blocked.is_empty() && checks.conflicting_workspaces.is_empty() {
            out.push_str("- None recorded\n");
        } else {
            for task in blocked {
                out.push_str(&format!(
                    "- Task #{} {}: {}\n",
                    task.id,
                    task.title,
                    task.blocked_reason.as_deref().unwrap_or("blocked")
                ));
            }
            for (other, paths) in &checks.conflicting_workspaces {
                out.push_str(&format!(
                    "- Overlaps workspace {other} on {} file(s)\n",
                    paths.len()
                ));
            }
        }
        out.push('\n');

        out.push_str("## Next actions\n\n");
        for action in next_actions(&checks, &tasks, changed.len()) {
            out.push_str(&format!("- {action}\n"));
        }

        Ok(out)
    }

    /// Draft a per-session handoff summary from what that session actually did.
    pub fn draft_session_summary(&self, workspace_name: &str, session_id: i64) -> Result<String> {
        let contribution = self
            .session_contributions(workspace_name)?
            .into_iter()
            .find(|contribution| contribution.session_id == session_id)
            .with_context(|| format!("session {session_id} not found in {workspace_name}"))?;

        let mut out = String::new();
        out.push_str(&format!("# {}\n\n", contribution.title));
        out.push_str(&format!(
            "- Harness: {}\n- Status: {}\n",
            contribution.provider, contribution.status
        ));
        if let Some(task_title) = &contribution.task_title {
            out.push_str(&format!(
                "- Task: #{} {}\n",
                contribution.task_id.unwrap_or_default(),
                task_title
            ));
        }
        out.push('\n');

        out.push_str("## Files touched\n\n");
        if contribution.files_touched.is_empty() {
            out.push_str("- None recorded\n");
        } else {
            for path in &contribution.files_touched {
                let marker = if contribution.still_present.contains(path) {
                    " (still changed in branch)"
                } else {
                    ""
                };
                out.push_str(&format!("- {path}{marker}\n"));
            }
        }
        out.push('\n');

        out.push_str("## Handoff\n\n");
        out.push_str(if contribution.still_present.is_empty() {
            "- No outstanding uncommitted changes from this session\n"
        } else {
            "- Review this session's changes before committing\n"
        });

        Ok(out)
    }

    /// Draft an operational summary for one task: status, linked sessions, and
    /// review state.
    pub fn draft_task_summary(&self, workspace_name: &str, task_id: i64) -> Result<String> {
        let task = self.task_in_workspace(workspace_name, task_id)?;
        let mut out = String::new();
        out.push_str(&format!("# Task #{} {}\n\n", task.id, task.title));
        out.push_str(&format!("- Status: {}\n", task.status));
        if let Some(owner) = &task.owner {
            out.push_str(&format!("- Owner: {owner}\n"));
        }
        if let Some(reason) = &task.blocked_reason {
            out.push_str(&format!("- Blocked: {reason}\n"));
        }
        if !task.linked_session_ids.is_empty() {
            out.push_str(&format!(
                "- Linked sessions: {}\n",
                task.linked_session_ids
                    .iter()
                    .map(|id| format!("#{id}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !task.body.is_empty() {
            out.push_str(&format!("\n{}\n", task.body));
        }
        if !task.review_notes.is_empty() {
            out.push_str(&format!("\n## Review notes\n\n{}\n", task.review_notes));
        }
        Ok(out)
    }

    // ---- Continuous summary maintenance ------------------------------------

    /// Refresh one continuously maintained summary from branch-local evidence.
    /// Idempotent: when the evidence cursor is unchanged the stored summary is
    /// left alone and `changed` is false.
    pub fn refresh_summary(&self, scope: SummaryRefreshScope) -> Result<SummaryRefreshResult> {
        match scope {
            SummaryRefreshScope::Workspace { workspace } => {
                let body = self.draft_workspace_summary(&workspace)?;
                self.save_refreshed_summary(&workspace, "workspace", None, &body, "auto")
            }
            SummaryRefreshScope::CurrentChat {
                workspace,
                thread_id,
            } => {
                let body = self.draft_session_summary(&workspace, thread_id)?;
                self.save_refreshed_summary(&workspace, "session", Some(thread_id), &body, "auto")
            }
            SummaryRefreshScope::Task { workspace, task_id } => {
                let body = self.draft_task_summary(&workspace, task_id)?;
                self.save_refreshed_summary(&workspace, "task", Some(task_id), &body, "auto")
            }
        }
    }

    fn save_refreshed_summary(
        &self,
        workspace_name: &str,
        scope_type: &str,
        scope_id: Option<i64>,
        body: &str,
        source: &str,
    ) -> Result<SummaryRefreshResult> {
        let workspace = self.get_by_name(workspace_name)?;
        let scope_id = scope_id.unwrap_or(0);
        let (hash, latest_message_id, latest_provider_sequence) =
            self.summary_evidence(workspace_name, workspace.id, scope_type, scope_id, body)?;

        let existing_state = self.summary_refresh_state(workspace.id, scope_type, scope_id)?;
        let existing_summary = self.get_summary(workspace_name, scope_type, Some(scope_id))?;
        // Agent prose wins. The mechanical draft is a seed for the empty case,
        // so once an agent has written the summary the daemon stops rewriting it
        // — otherwise every file change would erase the handoff note.
        if let Some(summary) = existing_summary
            .as_ref()
            .filter(|summary| summary_is_agent_authored(summary))
        {
            let state = match &existing_state {
                Some(state) => state.clone(),
                None => {
                    self.record_summary_refresh_state(
                        workspace.id,
                        scope_type,
                        scope_id,
                        source,
                        &hash,
                        latest_message_id,
                        latest_provider_sequence,
                    )?;
                    self.summary_refresh_state(workspace.id, scope_type, scope_id)?
                        .context("summary refresh state was not stored")?
                }
            };
            return Ok(SummaryRefreshResult {
                summary: summary.clone(),
                state,
                changed: false,
            });
        }
        if let (Some(state), Some(summary)) = (&existing_state, &existing_summary) {
            if state.evidence_hash == hash {
                return Ok(SummaryRefreshResult {
                    summary: summary.clone(),
                    state: state.clone(),
                    changed: false,
                });
            }
        }

        let summary = self.save_summary(
            workspace_name,
            scope_type,
            Some(scope_id),
            body,
            &["archductor:refresh".to_owned()],
        )?;
        self.record_summary_refresh_state(
            workspace.id,
            scope_type,
            scope_id,
            source,
            &hash,
            latest_message_id,
            latest_provider_sequence,
        )?;
        let state = self
            .summary_refresh_state(workspace.id, scope_type, scope_id)?
            .context("summary refresh state was not stored")?;
        Ok(SummaryRefreshResult {
            summary,
            state,
            changed: true,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn record_summary_refresh_state(
        &self,
        workspace_id: i64,
        scope_type: &str,
        scope_id: i64,
        source: &str,
        evidence_hash: &str,
        latest_message_id: Option<i64>,
        latest_provider_sequence: Option<i64>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO summary_refresh_state (
                workspace_id, scope_type, scope_id, source, evidence_hash,
                latest_message_id, latest_provider_sequence, last_refreshed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(workspace_id, scope_type, scope_id) DO UPDATE SET
                source = excluded.source,
                evidence_hash = excluded.evidence_hash,
                latest_message_id = excluded.latest_message_id,
                latest_provider_sequence = excluded.latest_provider_sequence,
                last_refreshed_at = excluded.last_refreshed_at",
            params![
                workspace_id,
                scope_type,
                scope_id,
                source,
                evidence_hash,
                latest_message_id,
                latest_provider_sequence,
                timestamp()
            ],
        )?;
        Ok(())
    }

    fn summary_refresh_state(
        &self,
        workspace_id: i64,
        scope_type: &str,
        scope_id: i64,
    ) -> Result<Option<SummaryRefreshState>> {
        let state = self
            .conn
            .query_row(
                &format!(
                    "SELECT {REFRESH_STATE_COLUMNS} FROM summary_refresh_state
                     WHERE workspace_id = ?1 AND scope_type = ?2 AND scope_id = ?3"
                ),
                params![workspace_id, scope_type, scope_id],
                row_to_refresh_state,
            )
            .ok();
        Ok(state)
    }

    /// Hash the drafted body together with every evidence stream that feeds it,
    /// plus the newest chat message id and provider timeline sequence as the
    /// stored cursor.
    fn summary_evidence(
        &self,
        workspace_name: &str,
        workspace_id: i64,
        scope_type: &str,
        scope_id: i64,
        body: &str,
    ) -> Result<(String, Option<i64>, Option<i64>)> {
        let (latest_message_id, latest_provider_sequence) = if scope_type == "session" {
            (
                self.conn.query_row(
                    "SELECT MAX(id) FROM chat_messages WHERE thread_id = ?1",
                    [scope_id],
                    |row| row.get::<_, Option<i64>>(0),
                )?,
                self.conn.query_row(
                    "SELECT MAX(timeline_seq) FROM provider_events WHERE chat_thread_id = ?1",
                    [scope_id],
                    |row| row.get::<_, Option<i64>>(0),
                )?,
            )
        } else {
            (
                self.conn.query_row(
                    "SELECT MAX(m.id) FROM chat_messages m
                       JOIN chat_threads t ON t.id = m.thread_id
                      WHERE t.workspace_id = ?1",
                    [workspace_id],
                    |row| row.get::<_, Option<i64>>(0),
                )?,
                self.conn.query_row(
                    "SELECT MAX(timeline_seq) FROM provider_events WHERE workspace_id = ?1",
                    [workspace_id],
                    |row| row.get::<_, Option<i64>>(0),
                )?,
            )
        };

        let tasks = self.list_tasks(workspace_name)?;
        let changed = self.changed_files(workspace_name).unwrap_or_default();
        let checks = self.checks_summary(workspace_name)?;
        let mut evidence = String::new();
        evidence.push_str(body);
        for task in &tasks {
            evidence.push_str(&format!("|task:{}:{}", task.id, task.updated_at));
        }
        evidence.push_str(&format!(
            "|msg:{latest_message_id:?}|seq:{latest_provider_sequence:?}|files:{}|checks:{:?}:{:?}:{}:{}",
            changed.join(","),
            checks.check_status,
            checks.run_status,
            checks.active_sessions,
            checks.open_review_comments
        ));
        Ok((
            evidence_hash(&evidence),
            latest_message_id,
            latest_provider_sequence,
        ))
    }

    /// One combined markdown briefing: stored workspace summary (or a fresh
    /// draft), the current chat's summary when a thread is named, tasks, and
    /// next actions.
    pub fn context_briefing(
        &self,
        workspace_name: &str,
        thread_id: Option<i64>,
    ) -> Result<ContextBriefing> {
        let tasks = self.list_tasks(workspace_name)?;
        let checks = self.checks_summary(workspace_name)?;
        let changed = self.changed_files(workspace_name).unwrap_or_default();
        let mut summary_ids = Vec::new();

        let mut body = String::new();
        body.push_str("## Workspace\n\n");
        match self.get_summary(workspace_name, "workspace", None)? {
            Some(summary) => {
                summary_ids.push(summary.id);
                body.push_str(summary.body_markdown.trim());
            }
            None => body.push_str(self.draft_workspace_summary(workspace_name)?.trim()),
        }
        body.push_str("\n\n");

        if let Some(thread_id) = thread_id {
            body.push_str("## Current chat\n\n");
            match self.get_summary(workspace_name, "session", Some(thread_id))? {
                Some(summary) => {
                    summary_ids.push(summary.id);
                    body.push_str(summary.body_markdown.trim());
                }
                None => body.push_str(
                    self.draft_session_summary(workspace_name, thread_id)?
                        .trim(),
                ),
            }
            body.push_str("\n\n");
        }

        body.push_str("## Tasks\n\n");
        if tasks.is_empty() {
            body.push_str("- None\n");
        } else {
            for task in &tasks {
                body.push_str(&format!(
                    "- [{}] #{} {}\n",
                    task.status, task.id, task.title
                ));
            }
        }
        body.push('\n');

        body.push_str("## Next actions\n\n");
        for action in next_actions(&checks, &tasks, changed.len()) {
            body.push_str(&format!("- {action}\n"));
        }

        Ok(ContextBriefing {
            workspace: workspace_name.to_owned(),
            thread_id,
            body_markdown: body,
            summary_ids,
            task_ids: tasks.iter().map(|task| task.id).collect(),
        })
    }

    // ---- Native chat task sync ---------------------------------------------

    /// Create native workspace tasks from clear action items in chat messages.
    /// Only bulleted lines that start with an action verb become tasks, titles
    /// are deduplicated (case-insensitively) against existing tasks, and
    /// human-created tasks are never replaced.
    pub fn sync_chat_tasks(
        &self,
        workspace_name: &str,
        thread_id: Option<i64>,
    ) -> Result<TaskSyncResult> {
        let workspace = self.get_by_name(workspace_name)?;
        if let Some(thread_id) = thread_id {
            self.ensure_session_in_workspace(workspace.id, thread_id)?;
        }

        let mut stmt = self.conn.prepare(
            "SELECT m.thread_id, m.content FROM chat_messages m
               JOIN chat_threads t ON t.id = m.thread_id
              WHERE t.workspace_id = ?1
                AND (?2 IS NULL OR m.thread_id = ?2)
                AND m.role = 'assistant'
              ORDER BY m.id",
        )?;
        let messages = stmt
            .query_map(params![workspace.id, thread_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let existing = self.list_tasks(workspace_name)?;
        let mut seen_titles: BTreeSet<String> = existing
            .iter()
            .map(|task| normalize_task_title(&task.title))
            .collect();

        let mut created = 0;
        let mut task_ids = Vec::new();
        for (message_thread_id, content) in messages {
            for title in extract_action_items(&content) {
                let normalized = normalize_task_title(&title);
                if !seen_titles.insert(normalized) {
                    continue;
                }
                let task = self.create_task(
                    workspace_name,
                    &title,
                    &format!("Source: chat:{message_thread_id}"),
                    &[],
                )?;
                created += 1;
                task_ids.push(task.id);
            }
        }

        Ok(TaskSyncResult {
            workspace: workspace_name.to_owned(),
            thread_id,
            created,
            updated: 0,
            task_ids,
        })
    }

    // ---- Context attachments ----------------------------------------------

    pub fn add_context_attachment(
        &self,
        workspace_name: &str,
        source: &str,
        kind: &str,
        body_or_ref: &str,
        scope: &str,
        pinned: bool,
    ) -> Result<ContextAttachment> {
        let source = validate(source, &CONTEXT_SOURCES, "context source")?;
        let kind = validate(kind, &CONTEXT_KINDS, "context kind")?;
        let body_or_ref = body_or_ref.trim();
        anyhow::ensure!(
            !body_or_ref.is_empty(),
            "context body or reference is required"
        );
        let workspace = self.get_by_name(workspace_name)?;
        self.conn.execute(
            "INSERT INTO context_attachments (
                workspace_id, source, kind, body_or_ref, scope, pinned, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                workspace.id,
                source,
                kind,
                body_or_ref,
                scope.trim(),
                i64::from(pinned),
                timestamp()
            ],
        )?;
        self.get_context_attachment(self.conn.last_insert_rowid())
    }

    pub fn list_context_attachments(&self, workspace_name: &str) -> Result<Vec<ContextAttachment>> {
        let workspace = self.get_by_name(workspace_name)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {CONTEXT_COLUMNS} FROM context_attachments WHERE workspace_id = ?1
             ORDER BY pinned DESC, id DESC"
        ))?;
        let attachments = stmt
            .query_map([workspace.id], row_to_context_attachment)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(attachments)
    }

    pub fn get_context_attachment(&self, id: i64) -> Result<ContextAttachment> {
        self.conn
            .query_row(
                &format!("SELECT {CONTEXT_COLUMNS} FROM context_attachments WHERE id = ?1"),
                [id],
                row_to_context_attachment,
            )
            .with_context(|| format!("load context attachment {id}"))
    }

    pub fn remove_context_attachment(&self, workspace_name: &str, id: i64) -> Result<()> {
        let workspace = self.get_by_name(workspace_name)?;
        let changed = self.conn.execute(
            "DELETE FROM context_attachments WHERE id = ?1 AND workspace_id = ?2",
            params![id, workspace.id],
        )?;
        anyhow::ensure!(
            changed > 0,
            "context attachment {id} not found in workspace {workspace_name}"
        );
        Ok(())
    }

    /// Draft a pull-request title and body from branch-local evidence: the
    /// workspace summary, per-session contributions, checks, and known risks.
    /// This is what makes background PRs reviewable.
    pub fn draft_pull_request(&self, workspace_name: &str) -> Result<(String, String)> {
        let workspace = self.get_by_name(workspace_name)?;
        let tasks = self.list_tasks(workspace_name)?;
        let contributions = self
            .session_contributions(workspace_name)
            .unwrap_or_default();
        let checks = self.checks_summary(workspace_name)?;
        let changed = self.changed_files(workspace_name).unwrap_or_default();
        let stored = self.get_summary(workspace_name, "workspace", None)?;

        let title = tasks
            .iter()
            .find(|task| task.status != "done")
            .map(|task| task.title.clone())
            // The first chat's agent-supplied title describes the task in prose;
            // a branch slug with the dashes swapped out does not.
            .or_else(|| {
                self.list_chat_threads(workspace_name)
                    .ok()?
                    .into_iter()
                    .find(|thread| !is_placeholder_chat_title(&thread.title))
                    .map(|thread| thread.title)
            })
            .unwrap_or_else(|| {
                let branch = workspace
                    .branch
                    .rsplit('/')
                    .next()
                    .unwrap_or(&workspace.branch);
                branch.replace(['-', '_'], " ")
            });

        let mut body = String::new();
        body.push_str("## Summary\n\n");
        match stored {
            Some(summary) => {
                body.push_str(summary.body_markdown.trim());
                body.push_str("\n\n");
            }
            None => {
                body.push_str(&format!(
                    "Changes on `{}` ({} file(s) changed).\n\n",
                    workspace.branch,
                    changed.len()
                ));
            }
        }

        if !tasks.is_empty() {
            body.push_str("## Tasks\n\n");
            for task in &tasks {
                body.push_str(&format!("- [{}] {}\n", task.status, task.title));
            }
            body.push('\n');
        }

        if !contributions.is_empty() {
            body.push_str("## Agent contributions\n\n");
            for contribution in &contributions {
                body.push_str(&format!(
                    "- **{}** ({}): {} file(s) touched\n",
                    contribution.title,
                    contribution.provider,
                    contribution.files_touched.len()
                ));
            }
            body.push('\n');
        }

        body.push_str("## Checks\n\n");
        body.push_str(&format!(
            "- Latest check run: {}\n- Open review comments: {}\n",
            checks
                .check_status
                .map(|status| status.as_str().to_owned())
                .unwrap_or_else(|| "not run".to_owned()),
            checks.open_review_comments
        ));
        body.push('\n');

        body.push_str("## Risks\n\n");
        let mut risks = Vec::new();
        for task in tasks.iter().filter(|task| task.status == "blocked") {
            risks.push(format!(
                "Task #{} blocked: {}",
                task.id,
                task.blocked_reason
                    .as_deref()
                    .unwrap_or("no reason recorded")
            ));
        }
        for (other, paths) in &checks.conflicting_workspaces {
            risks.push(format!(
                "Overlaps workspace {other} on {} file(s)",
                paths.len()
            ));
        }
        // Stored per-session provenance carries its own risks/blockers.
        for stored in self
            .list_diff_contributions(workspace_name)
            .unwrap_or_default()
        {
            for risk in &stored.risks {
                risks.push(format!("Session {}: {risk}", stored.session_id));
            }
            for blocker in &stored.blockers {
                risks.push(format!("Session {} blocked: {blocker}", stored.session_id));
            }
        }
        if checks.check_status.is_none() {
            risks.push("No checks were run in this workspace".to_owned());
        }
        if risks.is_empty() {
            body.push_str("- None identified\n");
        } else {
            for risk in risks {
                body.push_str(&format!("- {risk}\n"));
            }
        }

        Ok((title, body))
    }

    // ---- Per-session contributions ----------------------------------------

    /// Per-agent diff contributions: which session touched which files, and
    /// whether those files still differ in the branch.
    pub fn session_contributions(&self, workspace_name: &str) -> Result<Vec<SessionContribution>> {
        let workspace = self.get_by_name(workspace_name)?;
        let changed = self.changed_files(workspace_name).unwrap_or_default();
        let summaries = self.list_summaries(workspace_name)?;

        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.title, t.provider, t.status, t.task_id, t.intended_areas,
                    t.created_at, t.updated_at, tk.title, t.model
               FROM chat_threads t
               LEFT JOIN tasks tk ON tk.id = t.task_id
              WHERE t.workspace_id = ?1
              ORDER BY t.id",
        )?;
        let rows = stmt
            .query_map([workspace.id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut contributions = Vec::new();
        for (
            session_id,
            title,
            provider,
            status,
            task_id,
            intended_areas,
            created_at,
            updated_at,
            task_title,
            model,
        ) in rows
        {
            let files_touched =
                self.session_files_touched(session_id, &workspace.path.to_string_lossy())?;
            let still_present = files_touched
                .iter()
                .filter(|path| changed.contains(path))
                .cloned()
                .collect();
            let summary = summaries
                .iter()
                .find(|summary| summary.scope_type == "session" && summary.scope_id == session_id)
                .map(|summary| summary.body_markdown.clone());
            contributions.push(SessionContribution {
                session_id,
                title,
                provider,
                model,
                status,
                task_id,
                task_title,
                files_touched,
                still_present,
                intended_areas: intended_areas
                    .as_deref()
                    .map(split_list)
                    .unwrap_or_default(),
                summary,
                created_at,
                updated_at,
            });
        }
        Ok(contributions)
    }

    fn session_files_touched(&self, session_id: i64, workspace_path: &str) -> Result<Vec<String>> {
        let mut paths: BTreeSet<String> = BTreeSet::new();

        // TUI-parsed transcripts record the path directly on the chat event.
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT path FROM chat_events
              WHERE thread_id = ?1 AND path IS NOT NULL AND path <> ''",
        )?;
        for path in stmt
            .query_map([session_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
        {
            paths.insert(relative_workspace_path(&path, workspace_path));
        }

        // Managed sessions (Codex app-server, Claude stream-json) report file
        // changes as provider events instead, one `<kind> <path>` line each.
        let mut stmt = self.conn.prepare(
            "SELECT normalized_payload_json FROM provider_events
              WHERE chat_thread_id = ?1 AND kind = 'diff_file_change'",
        )?;
        for payload in stmt
            .query_map([session_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
        {
            let body = serde_json::from_str::<serde_json::Value>(&payload)
                .ok()
                .and_then(|value| {
                    value
                        .get("body")
                        .and_then(|body| body.as_str())
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            for path in parse_file_change_body(&body) {
                paths.insert(relative_workspace_path(&path, workspace_path));
            }
        }

        Ok(paths.into_iter().collect())
    }

    /// Persist a durable snapshot of one session's contribution: files touched,
    /// which still differ from base, its patch (written under `.context`), the
    /// commands the daemon ran for it, plus caller-supplied risks/blockers.
    /// Upserts per (workspace, session) so re-snapshotting refreshes the row.
    pub fn snapshot_diff_contribution(
        &self,
        workspace_name: &str,
        session_id: i64,
        risks: &[String],
        blockers: &[String],
    ) -> Result<DiffContribution> {
        let workspace = self.get_by_name(workspace_name)?;
        self.ensure_session_in_workspace(workspace.id, session_id)?;

        let files = self.session_files_touched(session_id, &workspace.path.to_string_lossy())?;
        let changed = self.changed_files(workspace_name).unwrap_or_default();
        let still_present: Vec<String> = files
            .iter()
            .filter(|path| changed.contains(path))
            .cloned()
            .collect();
        let commands: Vec<String> = self
            .session_run_history(workspace_name, session_id)?
            .into_iter()
            .map(|run| format!("{}: {} [{}]", run.kind, run.command, run.status))
            .collect();

        // Store the branch diff restricted to this session's files. Best
        // effort: with several agents on one branch the per-file diff can
        // include other sessions' edits to the same file.
        let mut patch = String::new();
        for path in &files {
            if let Ok(diff) =
                self.unified_diff_against_base(workspace_name, Some(std::path::Path::new(path)))
            {
                if !diff.trim().is_empty() {
                    patch.push_str(&diff);
                    if !diff.ends_with('\n') {
                        patch.push('\n');
                    }
                }
            }
        }
        let patch_ref = if patch.is_empty() {
            None
        } else {
            let relative = format!(".context/archductor/contributions/session-{session_id}.patch");
            let absolute = workspace.path.join(&relative);
            if let Some(parent) = absolute.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("create {}", parent.display()))?;
            }
            std::fs::write(&absolute, &patch)
                .with_context(|| format!("write {}", absolute.display()))?;
            Some(relative)
        };

        let now = timestamp();
        self.conn.execute(
            "INSERT INTO diff_contributions (
                workspace_id, session_id, files, still_present, patch_ref,
                commands, risks, blockers, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT(workspace_id, session_id) DO UPDATE SET
                files = excluded.files,
                still_present = excluded.still_present,
                patch_ref = excluded.patch_ref,
                commands = excluded.commands,
                risks = excluded.risks,
                blockers = excluded.blockers,
                updated_at = excluded.updated_at",
            params![
                workspace.id,
                session_id,
                join_list(&files),
                join_list(&still_present),
                patch_ref,
                join_list(&commands),
                join_list(risks),
                join_list(blockers),
                now
            ],
        )?;
        self.conn
            .query_row(
                &format!(
                    "SELECT {DIFF_CONTRIBUTION_COLUMNS} FROM diff_contributions
                     WHERE workspace_id = ?1 AND session_id = ?2"
                ),
                params![workspace.id, session_id],
                row_to_diff_contribution,
            )
            .context("diff contribution was not stored")
    }

    /// The stored per-session diff contributions for a workspace.
    pub fn list_diff_contributions(&self, workspace_name: &str) -> Result<Vec<DiffContribution>> {
        let workspace = self.get_by_name(workspace_name)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {DIFF_CONTRIBUTION_COLUMNS} FROM diff_contributions
             WHERE workspace_id = ?1 ORDER BY session_id"
        ))?;
        let contributions = stmt
            .query_map([workspace.id], row_to_diff_contribution)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(contributions)
    }

    /// The commands, checks, and runs the daemon executed for one session —
    /// its attached run history, straight from the processes table.
    pub fn session_run_history(
        &self,
        workspace_name: &str,
        session_id: i64,
    ) -> Result<Vec<SessionRunRecord>> {
        let workspace = self.get_by_name(workspace_name)?;
        self.ensure_session_in_workspace(workspace.id, session_id)?;
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, command, status, exit_code, started_at, ended_at
               FROM processes
              WHERE chat_thread_id = ?1
              ORDER BY id",
        )?;
        let runs = stmt
            .query_map([session_id], |row| {
                Ok(SessionRunRecord {
                    process_id: row.get(0)?,
                    kind: row.get(1)?,
                    command: row.get(2)?,
                    status: row.get(3)?,
                    exit_code: row.get(4)?,
                    started_at: row.get(5)?,
                    ended_at: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(runs)
    }

    /// Advisory overlap warnings between concurrent sessions in one workspace:
    /// same files touched, or declared intended areas that collide.
    pub fn session_overlaps(&self, workspace_name: &str) -> Result<Vec<SessionOverlap>> {
        let contributions = self.session_contributions(workspace_name)?;
        let mut overlaps = Vec::new();
        for (index, contribution) in contributions.iter().enumerate() {
            for other in contributions.iter().skip(index + 1) {
                let mut paths: Vec<String> = contribution
                    .files_touched
                    .iter()
                    .filter(|path| other.files_touched.contains(path))
                    .cloned()
                    .collect();
                for area in &contribution.intended_areas {
                    if other.intended_areas.contains(area) && !paths.contains(area) {
                        paths.push(area.clone());
                    }
                }
                if paths.is_empty() {
                    continue;
                }
                paths.sort();
                overlaps.push(SessionOverlap {
                    session_id: contribution.session_id,
                    session_title: contribution.title.clone(),
                    other_session_id: other.session_id,
                    other_session_title: other.title.clone(),
                    paths,
                });
            }
        }
        Ok(overlaps)
    }
}

/// Leading verbs that mark a bulleted line as a clear action item. Kept
/// deliberately small: it is better to miss a vague line than to spam tasks.
const ACTION_VERBS: [&str; 12] = [
    "add",
    "wire",
    "fix",
    "investigate",
    "verify",
    "follow up",
    "implement",
    "remove",
    "update",
    "refactor",
    "test",
    "document",
];

fn normalize_task_title(title: &str) -> String {
    title.trim().to_lowercase()
}

/// Pull clear action-item titles out of one chat message: bulleted lines
/// (`- ` / `* `, optionally a `- [ ]` checkbox) that start with an action verb.
fn extract_action_items(content: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let item = line
                .strip_prefix("- ")
                .or_else(|| line.strip_prefix("* "))?
                .trim();
            let item = item
                .strip_prefix("[ ]")
                .or_else(|| item.strip_prefix("[x]"))
                .unwrap_or(item)
                .trim();
            if item.is_empty() || item.chars().count() > 200 {
                return None;
            }
            let lower = item.to_lowercase();
            ACTION_VERBS
                .iter()
                .any(|verb| {
                    lower.starts_with(verb)
                        && lower[verb.len()..].chars().next().is_none_or(|c| c == ' ')
                })
                .then(|| item.to_owned())
        })
        .collect()
}

/// Chats open on a placeholder title and keep it until the agent supplies a real
/// one. Surfacing "New chat" as a goal or a pull request title is worse than
/// falling through to the branch name.
pub(crate) fn is_placeholder_chat_title(title: &str) -> bool {
    let title = title.trim();
    title.is_empty() || title.eq_ignore_ascii_case("new chat")
}

fn next_actions(
    checks: &crate::workspace::ChecksSummary,
    tasks: &[Task],
    changed_files: usize,
) -> Vec<String> {
    let mut actions = Vec::new();
    if let Some(task) = tasks.iter().find(|task| task.status == "blocked") {
        actions.push(format!(
            "Unblock task #{}: {}",
            task.id,
            task.blocked_reason
                .as_deref()
                .unwrap_or("no reason recorded")
        ));
    }
    if let Some(task) = tasks.iter().find(|task| task.status == "in_progress") {
        actions.push(format!("Finish task #{}: {}", task.id, task.title));
    }
    if checks.open_review_comments > 0 {
        actions.push(format!(
            "Resolve {} open review comment(s)",
            checks.open_review_comments
        ));
    }
    if changed_files > 0 && checks.pull_request.is_none() {
        actions.push("Commit changes and open a pull request".to_owned());
    }
    if checks.pull_request.is_some() {
        actions.push("Review pull request checks and merge blockers".to_owned());
    }
    if actions.is_empty() {
        actions.push("Start a task or an agent session".to_owned());
    }
    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::{AddRepository, RepositoryStore};
    use crate::workspace::CreateWorkspace;
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

    fn store_with_workspace(temp: &tempfile::TempDir) -> WorkspaceStore {
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
        let store = WorkspaceStore::open(&db_path).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        store
    }

    /// A second workspace in the same repository, so cross-workspace access can
    /// be exercised with real ids.
    fn add_sibling_workspace(store: &WorkspaceStore) {
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "oslo".to_owned(),
                branch: "lc/oslo".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
    }

    #[test]
    fn workspace_scoped_mutations_refuse_ids_from_another_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        add_sibling_workspace(&store);

        // Everything below belongs to `berlin`; every call names `oslo`.
        let task = store.create_task("berlin", "Berlin work", "", &[]).unwrap();
        let summary = store
            .save_summary("berlin", "workspace", None, "berlin body", &[])
            .unwrap();
        let attachment = store
            .add_context_attachment("berlin", "local", "note", "berlin note", "", false)
            .unwrap();

        let refused = [
            store
                .update_task(
                    "oslo",
                    task.id,
                    TaskUpdate {
                        status: Some("done".to_owned()),
                        ..TaskUpdate::default()
                    },
                )
                .map(|_| ())
                .unwrap_err(),
            store.delete_task("oslo", task.id).unwrap_err(),
            store.delete_summary("oslo", summary.id).unwrap_err(),
            store
                .remove_context_attachment("oslo", attachment.id)
                .unwrap_err(),
        ];
        for err in &refused {
            assert!(
                err.to_string().contains("oslo"),
                "error should name the workspace that was asked for: {err}"
            );
        }

        // None of the refused calls touched berlin's rows.
        assert_eq!(store.list_tasks("berlin").unwrap().len(), 1);
        assert_eq!(store.list_tasks("berlin").unwrap()[0].status, "todo");
        assert_eq!(store.list_summaries("berlin").unwrap().len(), 1);
        assert_eq!(store.list_context_attachments("berlin").unwrap().len(), 1);

        // The owning workspace still works.
        store.delete_summary("berlin", summary.id).unwrap();
        store
            .remove_context_attachment("berlin", attachment.id)
            .unwrap();
        store.delete_task("berlin", task.id).unwrap();
        assert!(store.list_tasks("berlin").unwrap().is_empty());
    }

    #[test]
    fn session_metadata_mutations_are_scoped_to_the_named_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        add_sibling_workspace(&store);

        let session = store
            .create_chat_thread("berlin", "codex", "berlin agent", None)
            .unwrap();
        let task = store.create_task("berlin", "Berlin work", "", &[]).unwrap();

        let err = store
            .assign_session_task("oslo", session.id, Some(task.id))
            .unwrap_err();
        assert!(err.to_string().contains("different workspace"), "{err}");

        let err = store
            .set_session_intended_areas("oslo", session.id, &["crates/core".to_owned()])
            .unwrap_err();
        assert!(err.to_string().contains("oslo"), "{err}");

        // The session kept its own workspace's metadata.
        let contributions = store.session_contributions("berlin").unwrap();
        assert_eq!(contributions.len(), 1);
        assert!(contributions[0].task_id.is_none());
        assert!(contributions[0].intended_areas.is_empty());

        // Naming the owning workspace works.
        store
            .assign_session_task("berlin", session.id, Some(task.id))
            .unwrap();
        store
            .set_session_intended_areas("berlin", session.id, &["crates/core".to_owned()])
            .unwrap();
        let contributions = store.session_contributions("berlin").unwrap();
        assert_eq!(contributions[0].task_id, Some(task.id));
        assert_eq!(
            contributions[0].intended_areas,
            vec!["crates/core".to_owned()]
        );
    }

    #[test]
    fn tasks_are_created_listed_updated_and_deleted() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);

        let task = store
            .create_task(
                "berlin",
                "Port right panel tabs",
                "Tasks/Summary/Context",
                &["desktop/src/pages".to_owned()],
            )
            .unwrap();
        assert_eq!(task.status, "todo");
        assert_eq!(task.intended_areas, vec!["desktop/src/pages".to_owned()]);
        assert_eq!(store.list_tasks("berlin").unwrap(), vec![task.clone()]);

        let updated = store
            .update_task(
                "berlin",
                task.id,
                TaskUpdate {
                    status: Some("in_progress".to_owned()),
                    ..TaskUpdate::default()
                },
            )
            .unwrap();
        assert_eq!(updated.status, "in_progress");

        store.delete_task("berlin", task.id).unwrap();
        assert!(store.list_tasks("berlin").unwrap().is_empty());
    }

    #[test]
    fn task_records_human_owner_review_notes_and_linked_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        let task = store.create_task("berlin", "Swarm slice", "", &[]).unwrap();
        assert_eq!(task.owner, None);
        assert_eq!(task.review_notes, "");
        assert!(task.linked_session_ids.is_empty());

        let updated = store
            .update_task(
                "berlin",
                task.id,
                TaskUpdate {
                    owner: Some(Some("  pranav  ".to_owned())),
                    review_notes: Some("check the migration ordering".to_owned()),
                    ..TaskUpdate::default()
                },
            )
            .unwrap();
        assert_eq!(updated.owner.as_deref(), Some("pranav"));
        assert_eq!(updated.review_notes, "check the migration ordering");

        // Linked sessions come from chat_threads.task_id.
        let first = store
            .create_chat_thread("berlin", "codex", "agent one", None)
            .unwrap();
        let second = store
            .create_chat_thread("berlin", "codex", "agent two", None)
            .unwrap();
        store
            .assign_session_task("berlin", first.id, Some(task.id))
            .unwrap();
        store
            .assign_session_task("berlin", second.id, Some(task.id))
            .unwrap();
        let task = store.get_task(task.id).unwrap();
        assert_eq!(task.linked_session_ids, vec![first.id, second.id]);
        assert_eq!(
            store.list_tasks("berlin").unwrap()[0].linked_session_ids,
            vec![first.id, second.id]
        );

        // Clearing the owner works; empty owner strings clear too.
        let cleared = store
            .update_task(
                "berlin",
                task.id,
                TaskUpdate {
                    owner: Some(None),
                    ..TaskUpdate::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.owner, None);
    }

    #[test]
    fn session_model_is_first_class_and_run_history_is_scoped() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        add_sibling_workspace(&store);

        let session = store
            .create_chat_thread(
                "berlin",
                "codex",
                "modelled agent",
                Some("harness=codex;model=gpt-5.6-sol;approval=never"),
            )
            .unwrap();
        assert_eq!(session.model.as_deref(), Some("gpt-5.6-sol"));

        // The model surfaces on per-session contributions too.
        let contributions = store.session_contributions("berlin").unwrap();
        assert_eq!(contributions[0].model.as_deref(), Some("gpt-5.6-sol"));

        // Metadata updates keep the column in sync; no model clears it.
        let updated = store
            .update_chat_thread_harness_metadata(session.id, Some("harness=codex;plan=true"))
            .unwrap();
        assert_eq!(updated.model, None);

        // Run history exists (empty here — no processes ran) and is scoped.
        assert!(store
            .session_run_history("berlin", session.id)
            .unwrap()
            .is_empty());
        let err = store.session_run_history("oslo", session.id).unwrap_err();
        assert!(err.to_string().contains("different workspace"), "{err}");
    }

    #[test]
    fn diff_contributions_snapshot_files_patch_and_provenance() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        add_sibling_workspace(&store);

        let session = store
            .create_chat_thread("berlin", "codex", "patch agent", None)
            .unwrap();

        // Give the session a touched file the same way managed sessions report
        // one: a diff_file_change provider event, plus a real edit on disk.
        let workspace_path = store.get_by_name("berlin").unwrap().path;
        std::fs::write(workspace_path.join("README.md"), "demo\nedited\n").unwrap();
        store
            .conn
            .execute(
                "INSERT INTO provider_events (
                    identity_key, provider, chat_thread_id, phase, kind,
                    received_sequence, occurred_at_ms, normalized_payload_json,
                    raw_json, schema_version, adapter_version, created_at, updated_at
                 ) VALUES ('k1', 'codex', ?1, 'turn', 'diff_file_change', 1, 0,
                           ?2, '{}', 1, 'test', '0', '0')",
                params![
                    session.id,
                    format!(
                        "{{\"body\": \"changed {}\"}}",
                        workspace_path.join("README.md").display()
                    )
                ],
            )
            .unwrap();

        let stored = store
            .snapshot_diff_contribution(
                "berlin",
                session.id,
                &["patch may include sibling edits".to_owned()],
                &["waiting on review".to_owned()],
            )
            .unwrap();
        assert_eq!(stored.files, vec!["README.md".to_owned()]);
        assert_eq!(stored.still_present, vec!["README.md".to_owned()]);
        let patch_ref = stored.patch_ref.clone().expect("patch stored");
        let patch = std::fs::read_to_string(workspace_path.join(&patch_ref)).unwrap();
        assert!(patch.contains("+edited"), "{patch}");
        assert_eq!(stored.risks, vec!["patch may include sibling edits"]);
        assert_eq!(stored.blockers, vec!["waiting on review"]);

        // Snapshots upsert per session rather than accumulating rows.
        let again = store
            .snapshot_diff_contribution("berlin", session.id, &[], &[])
            .unwrap();
        assert_eq!(again.id, stored.id);
        assert!(again.risks.is_empty());
        assert_eq!(store.list_diff_contributions("berlin").unwrap().len(), 1);

        // Stored risks surface in the PR draft.
        let risky = store
            .snapshot_diff_contribution(
                "berlin",
                session.id,
                &["migration ordering".to_owned()],
                &[],
            )
            .unwrap();
        assert!(risky.patch_ref.is_some());
        let (_, body) = store.draft_pull_request("berlin").unwrap();
        assert!(body.contains("migration ordering"), "{body}");

        // Scoped: another workspace cannot snapshot this session.
        let err = store
            .snapshot_diff_contribution("oslo", session.id, &[], &[])
            .unwrap_err();
        assert!(err.to_string().contains("different workspace"), "{err}");
    }

    #[test]
    fn task_status_is_validated_and_blocked_requires_a_reason() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        let task = store.create_task("berlin", "Ship it", "", &[]).unwrap();

        let err = store
            .update_task(
                "berlin",
                task.id,
                TaskUpdate {
                    status: Some("wobbly".to_owned()),
                    ..TaskUpdate::default()
                },
            )
            .unwrap_err();
        assert!(err.to_string().contains("unknown task status"), "{err}");

        let err = store
            .update_task(
                "berlin",
                task.id,
                TaskUpdate {
                    status: Some("blocked".to_owned()),
                    ..TaskUpdate::default()
                },
            )
            .unwrap_err();
        assert!(err.to_string().contains("blocked_reason"), "{err}");

        let blocked = store
            .update_task(
                "berlin",
                task.id,
                TaskUpdate {
                    status: Some("blocked".to_owned()),
                    blocked_reason: Some(Some("waiting on API key".to_owned())),
                    ..TaskUpdate::default()
                },
            )
            .unwrap();
        assert_eq!(
            blocked.blocked_reason.as_deref(),
            Some("waiting on API key")
        );
    }

    #[test]
    fn summaries_upsert_per_scope_and_reject_unknown_scopes() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);

        let first = store
            .save_summary(
                "berlin",
                "workspace",
                None,
                "first body",
                &["git status".to_owned()],
            )
            .unwrap();
        let second = store
            .save_summary("berlin", "workspace", None, "second body", &[])
            .unwrap();
        assert_eq!(first.id, second.id, "workspace summary should upsert");
        assert_eq!(second.body_markdown, "second body");
        assert_eq!(store.list_summaries("berlin").unwrap().len(), 1);

        let err = store
            .save_summary("berlin", "galaxy", None, "body", &[])
            .unwrap_err();
        assert!(err.to_string().contains("unknown summary scope"), "{err}");

        let err = store
            .save_summary("berlin", "session", None, "body", &[])
            .unwrap_err();
        assert!(err.to_string().contains("require a scope_id"), "{err}");
    }

    #[test]
    fn refresh_workspace_summary_records_evidence_cursor() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);

        let refreshed = store
            .refresh_summary(SummaryRefreshScope::Workspace {
                workspace: "berlin".to_owned(),
            })
            .unwrap();

        assert!(refreshed.changed);
        assert_eq!(refreshed.summary.scope_type, "workspace");
        assert_eq!(refreshed.summary.scope_id, 0);
        assert_eq!(refreshed.state.scope_type, "workspace");
        assert_eq!(refreshed.state.source, "auto");
        assert!(!refreshed.state.evidence_hash.is_empty());

        // Unchanged evidence leaves the stored summary alone.
        let again = store
            .refresh_summary(SummaryRefreshScope::Workspace {
                workspace: "berlin".to_owned(),
            })
            .unwrap();
        assert!(!again.changed);
        assert_eq!(again.summary.id, refreshed.summary.id);
        assert_eq!(again.summary.updated_at, refreshed.summary.updated_at);
        assert_eq!(again.state.evidence_hash, refreshed.state.evidence_hash);

        // New evidence (a task) flips the cursor and rewrites.
        store.create_task("berlin", "New goal", "", &[]).unwrap();
        let changed = store
            .refresh_summary(SummaryRefreshScope::Workspace {
                workspace: "berlin".to_owned(),
            })
            .unwrap();
        assert!(changed.changed);
        assert_ne!(changed.state.evidence_hash, refreshed.state.evidence_hash);
        assert!(changed.summary.body_markdown.contains("New goal"));
    }

    #[test]
    fn refresh_current_chat_summary_is_session_scoped() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        let thread = store
            .create_chat_thread("berlin", "codex", "Investigate summary tab", None)
            .unwrap();

        let refreshed = store
            .refresh_summary(SummaryRefreshScope::CurrentChat {
                workspace: "berlin".to_owned(),
                thread_id: thread.id,
            })
            .unwrap();

        assert_eq!(refreshed.summary.scope_type, "session");
        assert_eq!(refreshed.summary.scope_id, thread.id);
        assert!(refreshed
            .summary
            .body_markdown
            .contains("Investigate summary tab"));
    }

    #[test]
    fn refresh_task_summary_reports_task_state() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        let task = store
            .create_task("berlin", "Wire context tools", "Body text", &[])
            .unwrap();

        let refreshed = store
            .refresh_summary(SummaryRefreshScope::Task {
                workspace: "berlin".to_owned(),
                task_id: task.id,
            })
            .unwrap();

        assert_eq!(refreshed.summary.scope_type, "task");
        assert_eq!(refreshed.summary.scope_id, task.id);
        assert!(refreshed
            .summary
            .body_markdown
            .contains("Wire context tools"));
        assert!(refreshed.summary.body_markdown.contains("Status: todo"));
    }

    #[test]
    fn context_briefing_combines_workspace_chat_tasks_and_next_actions() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        let task = store
            .create_task("berlin", "Add summary tab", "Human context management", &[])
            .unwrap();
        let thread = store
            .create_chat_thread("berlin", "codex", "Implement context tools", None)
            .unwrap();
        store
            .assign_session_task("berlin", thread.id, Some(task.id))
            .unwrap();
        store
            .refresh_summary(SummaryRefreshScope::Workspace {
                workspace: "berlin".to_owned(),
            })
            .unwrap();
        store
            .refresh_summary(SummaryRefreshScope::CurrentChat {
                workspace: "berlin".to_owned(),
                thread_id: thread.id,
            })
            .unwrap();

        let briefing = store.context_briefing("berlin", Some(thread.id)).unwrap();

        assert_eq!(briefing.thread_id, Some(thread.id));
        assert!(briefing.body_markdown.contains("## Workspace"));
        assert!(briefing.body_markdown.contains("## Current chat"));
        assert!(briefing.body_markdown.contains("## Tasks"));
        assert!(briefing.body_markdown.contains("## Next actions"));
        assert!(briefing.body_markdown.contains("Add summary tab"));
        assert_eq!(briefing.summary_ids.len(), 2);
        assert_eq!(briefing.task_ids, vec![task.id]);
    }

    #[test]
    fn sync_chat_tasks_adds_bulleted_action_items_once() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        add_sibling_workspace(&store);
        let thread = store
            .create_chat_thread("berlin", "codex", "Plan work", None)
            .unwrap();
        store
            .append_chat_message(
                thread.id,
                "assistant",
                "Here is the plan:\n- Add Summary tab\n- Wire MCP refresh tool\n- maybe consider caching\nProse stays prose.",
                "test",
            )
            .unwrap();
        // User messages are not mined for tasks.
        store
            .append_chat_message(thread.id, "user", "- Fix everything", "test")
            .unwrap();

        let synced = store.sync_chat_tasks("berlin", Some(thread.id)).unwrap();
        let synced_again = store.sync_chat_tasks("berlin", Some(thread.id)).unwrap();
        let tasks = store.list_tasks("berlin").unwrap();

        assert_eq!(synced.created, 2);
        assert_eq!(synced.task_ids.len(), 2);
        assert_eq!(synced_again.created, 0);
        assert!(synced_again.task_ids.is_empty());
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().any(|task| task.title == "Add Summary tab"));
        assert!(tasks
            .iter()
            .any(|task| task.title == "Wire MCP refresh tool"));
        assert!(tasks
            .iter()
            .all(|task| task.body == format!("Source: chat:{}", thread.id)));

        // Existing (human) tasks with the same normalized title block re-creation.
        let err = store.sync_chat_tasks("oslo", Some(thread.id)).unwrap_err();
        assert!(err.to_string().contains("workspace"), "{err}");
    }

    #[test]
    fn workspace_summary_draft_reports_goal_blockers_and_next_actions() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        let task = store
            .create_task("berlin", "Wire the Context tab", "", &[])
            .unwrap();
        store
            .update_task(
                "berlin",
                task.id,
                TaskUpdate {
                    status: Some("blocked".to_owned()),
                    blocked_reason: Some(Some("needs archivum endpoint".to_owned())),
                    ..TaskUpdate::default()
                },
            )
            .unwrap();

        let draft = store.draft_workspace_summary("berlin").unwrap();
        assert!(draft.contains("Wire the Context tab"), "{draft}");
        assert!(draft.contains("needs archivum endpoint"), "{draft}");
        assert!(draft.contains("## Next actions"), "{draft}");
    }

    #[test]
    fn pull_request_draft_reports_tasks_checks_and_risks() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        let task = store
            .create_task("berlin", "Add the PR tab", "", &[])
            .unwrap();
        store
            .update_task(
                "berlin",
                task.id,
                TaskUpdate {
                    status: Some("blocked".to_owned()),
                    blocked_reason: Some(Some("waiting on gh auth".to_owned())),
                    ..TaskUpdate::default()
                },
            )
            .unwrap();

        let (title, body) = store.draft_pull_request("berlin").unwrap();
        assert_eq!(title, "Add the PR tab");
        assert!(body.contains("## Summary"), "{body}");
        assert!(body.contains("## Tasks"), "{body}");
        assert!(body.contains("waiting on gh auth"), "{body}");
        assert!(body.contains("No checks were run"), "{body}");
    }

    #[test]
    fn drafts_prefer_a_named_chat_over_the_branch_slug() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        store
            .create_chat_thread("berlin", "codex", "New chat", None)
            .unwrap();
        store
            .create_chat_thread("berlin", "codex", "Retry failed billing webhooks", None)
            .unwrap();

        // No tasks yet, so the agent-supplied chat title is the best description
        // available — better than "berlin" with its dashes swapped out.
        let (title, _) = store.draft_pull_request("berlin").unwrap();
        assert_eq!(title, "Retry failed billing webhooks");
        let summary = store.draft_workspace_summary("berlin").unwrap();
        assert!(
            summary.contains("Retry failed billing webhooks"),
            "{summary}"
        );
        assert!(!summary.contains("## Goal\n\nNew chat"), "{summary}");
    }

    #[test]
    fn drafts_fall_back_to_the_branch_when_every_chat_is_unnamed() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);
        store
            .create_chat_thread("berlin", "codex", "New chat", None)
            .unwrap();

        let (title, _) = store.draft_pull_request("berlin").unwrap();
        assert_eq!(title, "berlin");
        let summary = store.draft_workspace_summary("berlin").unwrap();
        assert!(summary.contains("Work on branch lc/berlin"), "{summary}");
    }

    #[test]
    fn file_change_bodies_parse_into_workspace_relative_paths() {
        assert_eq!(
            parse_file_change_body("changed /ws/berlin/README.md\nadded /ws/berlin/src/main.rs"),
            vec![
                "/ws/berlin/README.md".to_owned(),
                "/ws/berlin/src/main.rs".to_owned()
            ]
        );
        assert!(parse_file_change_body("   \n").is_empty());
        assert_eq!(
            relative_workspace_path("/ws/berlin/src/main.rs", "/ws/berlin"),
            "src/main.rs"
        );
        // Paths outside the workspace stay absolute rather than being mangled.
        assert_eq!(
            relative_workspace_path("/elsewhere/file.rs", "/ws/berlin"),
            "/elsewhere/file.rs"
        );
    }

    #[test]
    fn context_attachments_are_added_listed_and_removed() {
        let temp = tempfile::tempdir().unwrap();
        let store = store_with_workspace(&temp);

        let note = store
            .add_context_attachment(
                "berlin",
                "local",
                "note",
                "Ports are allocated per workspace",
                "",
                true,
            )
            .unwrap();
        assert!(note.pinned);
        let file = store
            .add_context_attachment("berlin", "local", "file", "docs/strategy.md", "repo", false)
            .unwrap();

        let listed = store.list_context_attachments("berlin").unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, note.id, "pinned attachments sort first");

        store.remove_context_attachment("berlin", file.id).unwrap();
        assert_eq!(store.list_context_attachments("berlin").unwrap().len(), 1);

        let err = store
            .add_context_attachment("berlin", "elsewhere", "note", "body", "", false)
            .unwrap_err();
        assert!(err.to_string().contains("unknown context source"), "{err}");
    }
}
