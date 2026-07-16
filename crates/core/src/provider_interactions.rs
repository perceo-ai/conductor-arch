use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::archcar::harness_contract::{
    ProviderInteractionDraft, ProviderInteractionKind, ProviderInteractionResolution,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderInteractionStatus {
    Pending,
    Allowed,
    Denied,
    Answered,
    Expired,
    Failed,
}

impl ProviderInteractionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Allowed => "allowed",
            Self::Denied => "denied",
            Self::Answered => "answered",
            Self::Expired => "expired",
            Self::Failed => "failed",
        }
    }

    fn from_str(value: &str) -> Self {
        match value {
            "allowed" => Self::Allowed,
            "denied" => Self::Denied,
            "answered" => Self::Answered,
            "expired" => Self::Expired,
            "failed" => Self::Failed,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderInteractionRecord {
    pub id: String,
    pub provider_key: String,
    pub workspace: String,
    pub thread_id: i64,
    pub session_id: i64,
    pub native_session_id: Option<String>,
    pub native_id: String,
    pub kind: ProviderInteractionKind,
    pub title: String,
    pub detail: String,
    pub choices: Vec<String>,
    pub native_request: Value,
    pub request_fingerprint: String,
    pub status: ProviderInteractionStatus,
    pub resolution: Option<ProviderInteractionResolution>,
    pub native_response: Option<Value>,
    pub error: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
    pub consumed_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderInteractionStore {
    db_path: PathBuf,
}

impl ProviderInteractionStore {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }

    pub fn register(&self, draft: ProviderInteractionDraft) -> Result<ProviderInteractionRecord> {
        let conn = self.open()?;
        let fingerprint = request_fingerprint(&draft);
        if let Some(existing) = self.find_pending_by_fingerprint(&fingerprint)? {
            return Ok(existing);
        }
        let now = timestamp();
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO provider_interactions (
                id, provider_key, workspace, thread_id, session_id, native_session_id, native_id,
                kind, title, detail, choices_json, native_request_json, request_fingerprint,
                status, resolution_json, native_response_json, error, created_at, resolved_at, consumed_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                'pending', NULL, NULL, NULL, ?14, NULL, NULL)",
            params![
                id,
                draft.provider_key,
                draft.workspace,
                draft.thread_id,
                draft.session_id,
                draft.native_session_id,
                draft.native_id,
                serde_json::to_string(&draft.kind)?,
                draft.title,
                draft.detail,
                serde_json::to_string(&draft.choices)?,
                serde_json::to_string(&draft.native_request)?,
                fingerprint,
                now,
            ],
        )?;
        Ok(self.get(&id)?.expect("provider interaction inserted"))
    }

    pub fn get(&self, id: &str) -> Result<Option<ProviderInteractionRecord>> {
        self.open()?
            .query_row(SELECT_RECORD_SQL, params![id], row_to_record)
            .optional()
            .map_err(Into::into)
    }

    pub fn list(
        &self,
        thread_id: Option<i64>,
        pending_only: bool,
    ) -> Result<Vec<ProviderInteractionRecord>> {
        let conn = self.open()?;
        let mut sql = SELECT_RECORD_LIST_SQL.to_owned();
        let records = match (thread_id, pending_only) {
            (Some(thread_id), true) => {
                sql.push_str(" WHERE thread_id = ?1 AND status = 'pending'");
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(params![thread_id], row_to_record)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            }
            (Some(thread_id), false) => {
                sql.push_str(" WHERE thread_id = ?1");
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(params![thread_id], row_to_record)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            }
            (None, true) => {
                sql.push_str(" WHERE status = 'pending'");
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map([], row_to_record)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            }
            (None, false) => {
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map([], row_to_record)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            }
        };
        Ok(records)
    }

    pub fn resolve(
        &self,
        id: &str,
        resolution: ProviderInteractionResolution,
    ) -> Result<ProviderInteractionRecord> {
        if let Some(existing) = self.get(id)? {
            if existing.status != ProviderInteractionStatus::Pending {
                return Ok(existing);
            }
        }
        let status = status_for_resolution(&resolution);
        let now = timestamp();
        self.open()?.execute(
            "UPDATE provider_interactions
             SET status = ?2, resolution_json = ?3, resolved_at = ?4
             WHERE id = ?1 AND status = 'pending'",
            params![
                id,
                status.as_str(),
                serde_json::to_string(&resolution)?,
                now
            ],
        )?;
        Ok(self.get(id)?.expect("provider interaction resolved"))
    }

    pub fn consume_resolution(
        &self,
        id: &str,
        native_response: Value,
    ) -> Result<ProviderInteractionRecord> {
        let now = timestamp();
        self.open()?.execute(
            "UPDATE provider_interactions
             SET native_response_json = COALESCE(native_response_json, ?2),
                 consumed_at = COALESCE(consumed_at, ?3)
             WHERE id = ?1",
            params![id, serde_json::to_string(&native_response)?, now],
        )?;
        Ok(self.get(id)?.expect("provider interaction consumed"))
    }

    fn find_pending_by_fingerprint(
        &self,
        fingerprint: &str,
    ) -> Result<Option<ProviderInteractionRecord>> {
        self.open()?
            .query_row(
                "SELECT id, provider_key, workspace, thread_id, session_id, native_session_id,
                    native_id, kind, title, detail, choices_json, native_request_json,
                    request_fingerprint, status, resolution_json, native_response_json, error,
                    created_at, resolved_at, consumed_at
                 FROM provider_interactions
                 WHERE request_fingerprint = ?1 AND status = 'pending'
                 ORDER BY created_at DESC
                 LIMIT 1",
                params![fingerprint],
                row_to_record,
            )
            .optional()
            .map_err(Into::into)
    }

    fn open(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }
}

const SELECT_RECORD_SQL: &str =
    "SELECT id, provider_key, workspace, thread_id, session_id, native_session_id,
    native_id, kind, title, detail, choices_json, native_request_json, request_fingerprint,
    status, resolution_json, native_response_json, error, created_at, resolved_at, consumed_at
    FROM provider_interactions WHERE id = ?1";

const SELECT_RECORD_LIST_SQL: &str =
    "SELECT id, provider_key, workspace, thread_id, session_id, native_session_id,
    native_id, kind, title, detail, choices_json, native_request_json, request_fingerprint,
    status, resolution_json, native_response_json, error, created_at, resolved_at, consumed_at
    FROM provider_interactions";

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderInteractionRecord> {
    let kind_json: String = row.get(7)?;
    let choices_json: String = row.get(10)?;
    let native_request_json: String = row.get(11)?;
    let status: String = row.get(13)?;
    let resolution_json: Option<String> = row.get(14)?;
    let native_response_json: Option<String> = row.get(15)?;
    Ok(ProviderInteractionRecord {
        id: row.get(0)?,
        provider_key: row.get(1)?,
        workspace: row.get(2)?,
        thread_id: row.get(3)?,
        session_id: row.get(4)?,
        native_session_id: row.get(5)?,
        native_id: row.get(6)?,
        kind: serde_json::from_str(&kind_json).unwrap_or(ProviderInteractionKind::Permission),
        title: row.get(8)?,
        detail: row.get(9)?,
        choices: serde_json::from_str(&choices_json).unwrap_or_default(),
        native_request: serde_json::from_str(&native_request_json).unwrap_or(Value::Null),
        request_fingerprint: row.get(12)?,
        status: ProviderInteractionStatus::from_str(&status),
        resolution: resolution_json.and_then(|json| serde_json::from_str(&json).ok()),
        native_response: native_response_json.and_then(|json| serde_json::from_str(&json).ok()),
        error: row.get(16)?,
        created_at: row.get(17)?,
        resolved_at: row.get(18)?,
        consumed_at: row.get(19)?,
    })
}

fn status_for_resolution(resolution: &ProviderInteractionResolution) -> ProviderInteractionStatus {
    match resolution {
        ProviderInteractionResolution::Approve => ProviderInteractionStatus::Allowed,
        ProviderInteractionResolution::Deny { .. } => ProviderInteractionStatus::Denied,
        ProviderInteractionResolution::Answer { .. } => ProviderInteractionStatus::Answered,
        ProviderInteractionResolution::Defer => ProviderInteractionStatus::Pending,
    }
}

fn request_fingerprint(draft: &ProviderInteractionDraft) -> String {
    let mut hasher = DefaultHasher::new();
    draft.provider_key.hash(&mut hasher);
    draft.workspace.hash(&mut hasher);
    draft.thread_id.hash(&mut hasher);
    draft.session_id.hash(&mut hasher);
    draft.native_id.hash(&mut hasher);
    serde_json::to_string(&draft.kind)
        .unwrap_or_default()
        .hash(&mut hasher);
    draft.native_request.to_string().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::migrate_workspace_db;
    use serde_json::json;

    #[test]
    fn provider_interactions_register_resolve_and_consume_resolution() {
        let (store, _temp) = seeded_store();
        let pending = store.register(fixture_draft()).unwrap();
        assert_eq!(pending.status, ProviderInteractionStatus::Pending);

        let resolved = store
            .resolve(
                &pending.id,
                ProviderInteractionResolution::Answer {
                    answers: vec![("confirm".to_owned(), "yes".to_owned())],
                },
            )
            .unwrap();
        assert_eq!(resolved.status, ProviderInteractionStatus::Answered);
        assert!(resolved.resolved_at.is_some());

        let consumed = store
            .consume_resolution(&pending.id, json!({"ok": true}))
            .unwrap();
        assert!(consumed.consumed_at.is_some());
    }

    #[test]
    fn provider_interactions_keep_repeated_resolution_idempotent() {
        let (store, _temp) = seeded_store();
        let pending = store.register(fixture_draft()).unwrap();
        let denied = store
            .resolve(
                &pending.id,
                ProviderInteractionResolution::Deny {
                    reason: Some("not now".to_owned()),
                },
            )
            .unwrap();
        let repeated = store
            .resolve(&pending.id, ProviderInteractionResolution::Approve)
            .unwrap();

        assert_eq!(repeated.status, ProviderInteractionStatus::Denied);
        assert_eq!(repeated.resolution, denied.resolution);
    }

    fn seeded_store() -> (ProviderInteractionStore, tempfile::TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let conn = Connection::open(&db_path).unwrap();
        migrate_workspace_db(&conn).unwrap();
        drop(conn);
        (ProviderInteractionStore::new(db_path), temp)
    }

    fn fixture_draft() -> ProviderInteractionDraft {
        ProviderInteractionDraft {
            provider_key: "claude".to_owned(),
            workspace: "berlin".to_owned(),
            thread_id: 7,
            session_id: 11,
            native_session_id: Some("session-1".to_owned()),
            native_id: "tool-1".to_owned(),
            kind: ProviderInteractionKind::UserQuestion,
            title: "Question".to_owned(),
            detail: "Continue?".to_owned(),
            choices: vec!["yes".to_owned(), "no".to_owned()],
            native_request: json!({"question": "Continue?"}),
        }
    }
}
