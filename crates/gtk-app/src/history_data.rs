//! Data projections for the GTK History page.
//!
//! This module keeps database reads and legacy Conductor imports separate from
//! widget construction so the History UI can be tested without a GTK display.

use archductor_core::import::default_conductor_app_database;
use archductor_core::workspace::{WorkspaceStatusLine, WorkspaceStore};
use rusqlite::Connection;
use std::path::Path;

/// Top-level History page tab.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HistoryTab {
    /// Workspace lifecycle history.
    #[default]
    Workspaces,
    /// Saved chat/session transcript history.
    Chats,
}

impl HistoryTab {
    /// Returns the GTK stack page name for the tab.
    pub(crate) fn stack_name(self) -> &'static str {
        match self {
            Self::Workspaces => "workspaces",
            Self::Chats => "chats",
        }
    }
}

/// Workspace archive/activity filter used by the History page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceHistoryFilter {
    /// Show every workspace.
    All,
    /// Show workspaces that are not archived.
    Active,
    /// Show archived workspaces only.
    Archived,
}

impl WorkspaceHistoryFilter {
    /// Ordered list of filters shown in the segmented control.
    pub(crate) const ALL: [Self; 3] = [Self::All, Self::Active, Self::Archived];

    /// Customer-facing filter label.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Active => "Active",
            Self::Archived => "Archived",
        }
    }

    /// Returns whether a workspace state belongs in this filter.
    pub(crate) fn matches(self, state: &str) -> bool {
        match self {
            Self::All => true,
            Self::Active => !state.eq_ignore_ascii_case("Archived"),
            Self::Archived => state.eq_ignore_ascii_case("Archived"),
        }
    }
}

/// Render-ready workspace row for the History page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceHistoryEntry {
    /// Workspace name.
    pub(crate) name: String,
    /// Owning project/repository display name.
    pub(crate) repository_name: String,
    /// Current branch name.
    pub(crate) branch: String,
    /// Base branch or ref used for comparisons.
    pub(crate) base_ref: String,
    /// Workspace path shown in detail rows.
    pub(crate) path: String,
    /// Stored workspace status.
    pub(crate) status: String,
    /// Derived state bucket shown in History.
    pub(crate) state: String,
    /// Last update timestamp.
    pub(crate) updated_at: String,
    /// Creation timestamp.
    pub(crate) created_at: String,
    /// Archive timestamp when archived.
    pub(crate) archived_at: Option<String>,
    /// Number of open todos in the workspace.
    pub(crate) open_todos: usize,
    /// Number of active agent or terminal sessions.
    pub(crate) active_sessions: usize,
    /// Whether the run script is currently running.
    pub(crate) run_running: bool,
    /// Open pull-request number when present.
    pub(crate) pull_request: Option<i64>,
    /// Current diff additions.
    pub(crate) diff_additions: usize,
    /// Current diff deletions.
    pub(crate) diff_deletions: usize,
}

/// Loads and sorts recent workspaces for the History page.
pub(crate) fn history_recent_workspaces(
    database_path: &Path,
) -> anyhow::Result<Vec<WorkspaceHistoryEntry>> {
    let store = WorkspaceStore::open_app(database_path)?;
    let mut workspaces = store
        .list_status()?
        .iter()
        .map(workspace_history_entry)
        .collect::<Vec<_>>();
    workspaces.sort_by(|left, right| {
        workspace_history_sort_key(right)
            .cmp(&workspace_history_sort_key(left))
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(workspaces)
}

fn workspace_history_entry(line: &WorkspaceStatusLine) -> WorkspaceHistoryEntry {
    WorkspaceHistoryEntry {
        name: line.workspace.name.clone(),
        repository_name: line.repository_name.clone(),
        branch: line.workspace.branch.clone(),
        base_ref: line.workspace.base_ref.clone(),
        path: line.workspace.path.to_string_lossy().to_string(),
        status: line.workspace.status.clone(),
        state: workspace_history_state(line).to_owned(),
        updated_at: line.workspace.updated_at.clone(),
        created_at: line.workspace.created_at.clone(),
        archived_at: line.workspace.archived_at.clone(),
        open_todos: line.open_todos,
        active_sessions: line.active_sessions,
        run_running: line.run_running,
        pull_request: line.pull_request.as_ref().map(|pr| pr.number),
        diff_additions: line.diff_additions,
        diff_deletions: line.diff_deletions,
    }
}

/// Returns whether the workspace has an open pull request.
pub(crate) fn workspace_has_open_pull_request(line: &WorkspaceStatusLine) -> bool {
    line.pull_request
        .as_ref()
        .is_some_and(|pull_request| pull_request.state.eq_ignore_ascii_case("open"))
}

fn workspace_history_state(line: &WorkspaceStatusLine) -> &'static str {
    if line.workspace.status == "archived" {
        "Archived"
    } else if workspace_has_open_pull_request(line) {
        "Review"
    } else if line.run_running || line.active_sessions > 0 {
        "Running"
    } else {
        "Ready"
    }
}

fn workspace_history_sort_key(workspace: &WorkspaceHistoryEntry) -> u8 {
    match workspace.state.as_str() {
        "Running" => 4,
        "Review" => 3,
        "Ready" => 2,
        "Archived" => 1,
        _ => 0,
    }
}

/// Source database for a chat history row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChatSource {
    /// Native Archductor thread-first chat history.
    Archductor,
    /// Older Archductor process transcript history.
    Legacy,
    /// Imported upstream Conductor app history.
    ImportedConductor,
}

impl ChatSource {
    /// Customer-facing source label.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Archductor => "Archductor",
            Self::Legacy => "Legacy",
            Self::ImportedConductor => "Imported Conductor",
        }
    }
}

/// Render-ready chat/session row for the History page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChatSummary {
    /// Stable source-qualified row identifier.
    pub(crate) id: String,
    /// Database family that produced the row.
    pub(crate) source: ChatSource,
    /// Chat or session title.
    pub(crate) title: String,
    /// Agent/provider label.
    pub(crate) agent_type: String,
    /// Stored session or thread status.
    pub(crate) status: String,
    /// Owning project/repository display name.
    pub(crate) repository_name: String,
    /// Workspace display name.
    pub(crate) workspace_name: String,
    /// Workspace path used for filtering and details.
    pub(crate) workspace_path: String,
    /// Last update timestamp.
    pub(crate) updated_at: String,
    /// Number of visible messages.
    pub(crate) message_count: i64,
}

/// Loads recent native and imported chat history rows.
pub(crate) fn history_recent_sessions(database_path: &Path) -> anyhow::Result<Vec<ChatSummary>> {
    let mut sessions = local_recent_sessions(database_path)?;
    sessions.extend(conductor_recent_sessions());
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions.truncate(200);
    Ok(sessions)
}

fn local_recent_sessions(database_path: &Path) -> anyhow::Result<Vec<ChatSummary>> {
    query_local_sessions(database_path, None)
}

fn conductor_recent_sessions() -> Vec<ChatSummary> {
    // Imported Conductor history is optional. A missing, locked, or incompatible
    // upstream database must not hide Archductor's own saved chats.
    query_conductor_sessions(None).unwrap_or_default()
}

/// Loads history rows for one workspace path.
pub(crate) fn sessions_for_workspace_path(database_path: &Path, path: &Path) -> Vec<ChatSummary> {
    let mut sessions = query_local_sessions(database_path, Some(path)).unwrap_or_default();
    sessions.extend(query_conductor_sessions(Some(path)).unwrap_or_default());
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions
}

fn query_local_sessions(
    database_path: &Path,
    path: Option<&Path>,
) -> anyhow::Result<Vec<ChatSummary>> {
    let store = WorkspaceStore::open_app(database_path)?;
    let mut sessions = store
        .list_local_chat_threads(path)?
        .into_iter()
        .map(|thread| ChatSummary {
            id: format!("local-thread:{}", thread.thread_id),
            source: ChatSource::Archductor,
            title: thread.title,
            agent_type: thread.provider,
            status: thread.status,
            repository_name: thread.repository_name,
            workspace_name: thread.workspace_name,
            workspace_path: thread.workspace_path.to_string_lossy().to_string(),
            updated_at: thread.updated_at,
            message_count: i64::try_from(thread.message_count).unwrap_or(i64::MAX),
        })
        .collect::<Vec<_>>();
    sessions.extend(
        store
            .list_local_chat_history(path)?
            .into_iter()
            .filter(|session| session.chat_thread_id.is_none())
            .map(|session| ChatSummary {
                id: format!("local:{}", session.process_id),
                source: ChatSource::Legacy,
                title: format!("{} session #{}", session.agent_type, session.process_id),
                agent_type: session.agent_type,
                status: session.status,
                repository_name: session.repository_name,
                workspace_name: session.workspace_name,
                workspace_path: session.workspace_path.to_string_lossy().to_string(),
                updated_at: session.updated_at,
                message_count: i64::try_from(session.message_count).unwrap_or(i64::MAX),
            }),
    );
    Ok(sessions)
}

fn query_conductor_sessions(path: Option<&Path>) -> rusqlite::Result<Vec<ChatSummary>> {
    let conn = Connection::open_with_flags(
        default_conductor_app_database(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut sql = String::from(
        "SELECT s.id,
                COALESCE(s.title, 'Untitled'),
                COALESCE(s.agent_type, ''),
                COALESCE(s.status, ''),
                COALESCE(r.name, ''),
                COALESCE(w.directory_name, ''),
                COALESCE(w.workspace_path, ''),
                COALESCE(s.updated_at, s.created_at, ''),
                COUNT(m.id)
         FROM sessions s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
         LEFT JOIN repos r ON r.id = w.repository_id
         LEFT JOIN session_messages m ON m.session_id = s.id",
    );
    if path.is_some() {
        sql.push_str(" WHERE w.workspace_path = ?1");
    }
    sql.push_str(" GROUP BY s.id ORDER BY COALESCE(s.updated_at, s.created_at) DESC LIMIT 200");

    let mut stmt = conn.prepare(&sql)?;
    if let Some(path) = path {
        stmt.query_map([path.to_string_lossy().to_string()], row_to_chat_summary)?
            .collect()
    } else {
        stmt.query_map([], row_to_chat_summary)?.collect()
    }
}

fn row_to_chat_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSummary> {
    let imported_id = row.get::<_, String>(0)?;
    Ok(ChatSummary {
        id: format!("imported:{imported_id}"),
        source: ChatSource::ImportedConductor,
        title: row.get(1)?,
        agent_type: row.get(2)?,
        status: row.get(3)?,
        repository_name: row.get(4)?,
        workspace_name: row.get(5)?,
        workspace_path: row.get(6)?,
        updated_at: row.get(7)?,
        message_count: row.get(8)?,
    })
}

pub(crate) fn history_session_messages(database_path: &Path, session_id: &str) -> String {
    if let Some(id) = session_id
        .strip_prefix("local-thread:")
        .and_then(|value| value.parse::<i64>().ok())
    {
        return local_thread_messages(database_path, id);
    }
    if let Some(id) = session_id
        .strip_prefix("local:")
        .and_then(|value| value.parse::<i64>().ok())
    {
        return local_session_messages(database_path, id);
    }
    conductor_session_messages(session_id.strip_prefix("imported:").unwrap_or(session_id))
}

fn local_thread_messages(database_path: &Path, thread_id: i64) -> String {
    let Ok(store) = WorkspaceStore::open_app(database_path) else {
        return "Could not open Archductor history database.".to_owned();
    };
    let Ok(messages) = store.list_chat_messages(thread_id) else {
        return "Could not read local chat thread.".to_owned();
    };
    format_local_messages(
        messages
            .into_iter()
            .map(|message| (message.role, message.content, Some(message.source))),
    )
}

fn local_session_messages(database_path: &Path, process_id: i64) -> String {
    let Ok(store) = WorkspaceStore::open_app(database_path) else {
        return "Could not open Archductor history database.".to_owned();
    };
    let Ok(messages) = store.local_chat_history_messages(process_id) else {
        return "Could not read local chat transcript.".to_owned();
    };
    format_local_messages(
        messages
            .into_iter()
            .map(|message| (message.role, message.content, None)),
    )
}

fn format_local_messages(
    messages: impl Iterator<Item = (String, String, Option<String>)>,
) -> String {
    let text = messages
        .map(|(role, content, source)| {
            format!(
                "{}\n{}\n",
                chat_role_label(&role, source.as_deref()),
                truncate_message(&content, 2200)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        "No messages in this chat.".to_owned()
    } else {
        text
    }
}

fn chat_role_label(role: &str, source: Option<&str>) -> &'static str {
    if role.eq_ignore_ascii_case("user") && source == Some("staged_review_send") {
        return "Review Prompt";
    }
    match role.to_ascii_lowercase().as_str() {
        "user" => "You",
        "review" => "Review Prompt",
        "system" => "System",
        _ => "Agent",
    }
}

fn conductor_session_messages(session_id: &str) -> String {
    let Ok(conn) = Connection::open_with_flags(
        default_conductor_app_database(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return "Could not open imported Conductor chat database.".to_owned();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT COALESCE(role, ''), COALESCE(content, full_message, ''), COALESCE(created_at, '')
         FROM session_messages
         WHERE session_id = ?1
         ORDER BY COALESCE(sent_at, created_at), queue_order
         LIMIT 160",
    ) else {
        return "Could not read imported Conductor chat messages.".to_owned();
    };
    let Ok(rows) = stmt.query_map([session_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) else {
        return "Could not load imported Conductor chat messages.".to_owned();
    };

    let mut text = String::new();
    for (role, content, created_at) in rows.flatten() {
        text.push_str(&format!(
            "{} · {}\n{}\n\n",
            chat_role_label(&role, None),
            created_at,
            truncate_message(&content, 2200)
        ));
    }
    if text.is_empty() {
        "No messages in this chat.".to_owned()
    } else {
        text
    }
}

fn truncate_message(content: &str, max_chars: usize) -> String {
    let mut truncated = content.chars().take(max_chars).collect::<String>();
    if content.chars().count() > max_chars {
        truncated.push_str("\n...");
    }
    truncated
}

#[cfg(test)]
mod tests {
    use super::{chat_role_label, ChatSource, HistoryTab, WorkspaceHistoryFilter};
    use archductor_core::workspace::{PullRequest, Workspace, WorkspaceStatusLine};
    use std::path::PathBuf;

    fn workspace_line(pr_state: Option<&str>, run_running: bool) -> WorkspaceStatusLine {
        WorkspaceStatusLine {
            workspace: Workspace {
                id: 1,
                repository_id: 1,
                name: "berlin".to_owned(),
                path: PathBuf::from("/tmp/berlin"),
                branch: "lc/berlin".to_owned(),
                base_ref: "main".to_owned(),
                port_base: 3000,
                status: "active".to_owned(),
                archived_at: None,
                created_at: "1".to_owned(),
                updated_at: "2".to_owned(),
            },
            repository_name: "demo".to_owned(),
            open_todos: 0,
            pull_request: pr_state.map(|state| PullRequest {
                id: 1,
                workspace_id: 1,
                provider: "github".to_owned(),
                number: 42,
                url: "https://example.test/pull/42".to_owned(),
                state: state.to_owned(),
                created_at: "1".to_owned(),
                updated_at: "2".to_owned(),
            }),
            run_running,
            active_sessions: 0,
            branch_push_state: None,
            diff_additions: 0,
            diff_deletions: 0,
        }
    }

    #[test]
    fn history_defaults_to_workspaces() {
        assert_eq!(HistoryTab::default(), HistoryTab::Workspaces);
    }

    #[test]
    fn workspace_filters_match_customer_visible_scopes() {
        assert!(WorkspaceHistoryFilter::All.matches("Active"));
        assert!(WorkspaceHistoryFilter::Active.matches("Ready"));
        assert!(WorkspaceHistoryFilter::Active.matches("Review"));
        assert!(!WorkspaceHistoryFilter::Active.matches("Archived"));
        assert!(WorkspaceHistoryFilter::Archived.matches("Archived"));
    }

    #[test]
    fn workspace_review_state_requires_an_open_pull_request() {
        assert_eq!(
            super::workspace_history_state(&workspace_line(Some("open"), false)),
            "Review"
        );
        assert_eq!(
            super::workspace_history_state(&workspace_line(Some("closed"), false)),
            "Ready"
        );
        assert_eq!(
            super::workspace_history_state(&workspace_line(Some("merged"), true)),
            "Running"
        );
    }

    #[test]
    fn local_history_database_failures_are_reported() {
        let temp = tempfile::tempdir().unwrap();

        let result = super::history_recent_sessions(temp.path());

        assert!(result.is_err());
    }

    #[test]
    fn chat_sources_explain_provenance() {
        assert_eq!(ChatSource::Archductor.label(), "Archductor");
        assert_eq!(ChatSource::Legacy.label(), "Legacy");
        assert_eq!(ChatSource::ImportedConductor.label(), "Imported Conductor");
    }

    #[test]
    fn chat_roles_keep_customer_facing_labels() {
        assert_eq!(chat_role_label("user", None), "You");
        assert_eq!(
            chat_role_label("user", Some("staged_review_send")),
            "Review Prompt"
        );
        assert_eq!(
            chat_role_label("assistant", Some("staged_review_send")),
            "Agent"
        );
        assert_eq!(chat_role_label("assistant", None), "Agent");
        assert_eq!(chat_role_label("system", None), "System");
        assert_eq!(chat_role_label("review", None), "Review Prompt");
    }
}
