use archductor_core::import::default_conductor_app_database;
use archductor_core::workspace::{WorkspaceStatusLine, WorkspaceStore};
use rusqlite::Connection;
use std::path::Path;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HistoryTab {
    #[default]
    Workspaces,
    Chats,
}

impl HistoryTab {
    pub(crate) fn stack_name(self) -> &'static str {
        match self {
            Self::Workspaces => "workspaces",
            Self::Chats => "chats",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceHistoryFilter {
    All,
    Active,
    Archived,
}

impl WorkspaceHistoryFilter {
    pub(crate) const ALL: [Self; 3] = [Self::All, Self::Active, Self::Archived];

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Active => "Active",
            Self::Archived => "Archived",
        }
    }

    pub(crate) fn matches(self, state: &str) -> bool {
        match self {
            Self::All => true,
            Self::Active => !state.eq_ignore_ascii_case("Archived"),
            Self::Archived => state.eq_ignore_ascii_case("Archived"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceHistoryEntry {
    pub(crate) name: String,
    pub(crate) repository_name: String,
    pub(crate) branch: String,
    pub(crate) base_ref: String,
    pub(crate) path: String,
    pub(crate) status: String,
    pub(crate) state: String,
    pub(crate) updated_at: String,
    pub(crate) created_at: String,
    pub(crate) archived_at: Option<String>,
    pub(crate) open_todos: usize,
    pub(crate) active_sessions: usize,
    pub(crate) run_running: bool,
    pub(crate) pull_request: Option<i64>,
    pub(crate) diff_additions: usize,
    pub(crate) diff_deletions: usize,
}

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

fn workspace_history_state(line: &WorkspaceStatusLine) -> &'static str {
    if line.workspace.status == "archived" {
        "Archived"
    } else if line.pull_request.is_some() {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChatSource {
    Archductor,
    Legacy,
    ImportedConductor,
}

impl ChatSource {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Archductor => "Archductor",
            Self::Legacy => "Legacy",
            Self::ImportedConductor => "Imported Conductor",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChatSummary {
    pub(crate) id: String,
    pub(crate) source: ChatSource,
    pub(crate) title: String,
    pub(crate) agent_type: String,
    pub(crate) status: String,
    pub(crate) repository_name: String,
    pub(crate) workspace_name: String,
    pub(crate) workspace_path: String,
    pub(crate) updated_at: String,
    pub(crate) message_count: i64,
}

pub(crate) fn history_recent_sessions(database_path: &Path) -> Vec<ChatSummary> {
    let mut sessions = local_recent_sessions(database_path);
    sessions.extend(conductor_recent_sessions());
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions.truncate(200);
    sessions
}

fn local_recent_sessions(database_path: &Path) -> Vec<ChatSummary> {
    query_local_sessions(database_path, None).unwrap_or_default()
}

fn conductor_recent_sessions() -> Vec<ChatSummary> {
    // Imported Conductor history is optional. A missing, locked, or incompatible
    // upstream database must not hide Archductor's own saved chats.
    query_conductor_sessions(None).unwrap_or_default()
}

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
    let Ok(messages) = store.local_chat_thread_messages(thread_id) else {
        return "Could not read local chat thread.".to_owned();
    };
    format_local_messages(
        messages
            .into_iter()
            .map(|message| (message.role, message.content)),
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
            .map(|message| (message.role, message.content)),
    )
}

fn format_local_messages(messages: impl Iterator<Item = (String, String)>) -> String {
    let text = messages
        .map(|(role, content)| {
            format!(
                "{}\n{}\n",
                chat_role_label(&role),
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

fn chat_role_label(role: &str) -> &'static str {
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
            chat_role_label(&role),
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
    fn chat_sources_explain_provenance() {
        assert_eq!(ChatSource::Archductor.label(), "Archductor");
        assert_eq!(ChatSource::Legacy.label(), "Legacy");
        assert_eq!(ChatSource::ImportedConductor.label(), "Imported Conductor");
    }

    #[test]
    fn chat_roles_keep_customer_facing_labels() {
        assert_eq!(chat_role_label("user"), "You");
        assert_eq!(chat_role_label("assistant"), "Agent");
        assert_eq!(chat_role_label("system"), "System");
        assert_eq!(chat_role_label("review"), "Review Prompt");
    }
}
