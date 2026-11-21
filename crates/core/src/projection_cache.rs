//! The daemon's per-thread chat projection cache.
//!
//! `GetChatProjection` re-read every `provider_events` row for the thread,
//! re-parsed both JSON blobs on each row, and re-projected the whole timeline —
//! on every refresh tick, up to several times a second per streaming thread.
//! Measured at 181ms and 1.4MB for a 4000-row thread
//! (`docs/evidence/2026-11-19-concurrent-chat-perf-baseline.md`).
//!
//! This keeps each thread's parsed records in memory so a pull skips the SQLite
//! read and the JSON parse. The projection itself is still built by
//! [`provider_projection_from_records`], the single definition of the timeline,
//! so output cannot drift from the uncached path.
//!
//! Why retain records rather than projected events: a record arriving later can
//! change an *earlier* item, and turn elapsed times are computed across the
//! whole record set (`provider_turn_durations`). Patching individual projected
//! items would mean reimplementing those merge rules beside the real ones.
//! Correctness first; the saving being banked here is the read and the parse.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::Result;

use crate::provider_events::ProviderEventRecord;
use crate::provider_projection::{provider_projection_from_records, ProviderProjection};

/// Threads kept at once. Beyond this, the least recently used is dropped and
/// rebuilds from the store on its next pull.
pub const DEFAULT_THREAD_CAPACITY: usize = 32;

/// Rough byte ceiling for one thread's retained records.
///
/// `raw_json` is where a screenshot's base64 lives, so a chat full of images
/// would otherwise pin tens of megabytes per thread in a daemon that runs for
/// days. A thread over the ceiling is served from the store instead: slower,
/// but the memory is bounded.
pub const DEFAULT_THREAD_BYTE_BUDGET: usize = 8 * 1024 * 1024;

/// The cache belongs to a database, not to a server object.
///
/// Records are written deep inside the session machinery (through
/// `RuntimeSessionStore`) and read in the request handler, and both already
/// carry the database path. Keying on it means those two meet without threading
/// a cache handle through a dozen call sites, while two different databases —
/// as in tests, or a daemon pointed at scratch state — never share entries.
fn registry() -> &'static Mutex<HashMap<PathBuf, Arc<ProjectionCache>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<ProjectionCache>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The projection cache for one database, creating it on first use.
pub fn cache_for(db_path: &Path) -> Arc<ProjectionCache> {
    // Canonicalize, so a reader reaching the database through /var and a writer
    // through /private/var (the same place, on macOS) share one entry. The two
    // agreeing is the invariant the whole cache rests on, and splitting it
    // would freeze a streaming chat at its first pull with nothing to show why.
    // Before the file exists there is nothing to resolve, so the raw path
    // stands in.
    let db_path = db_path
        .canonicalize()
        .unwrap_or_else(|_| db_path.to_path_buf());
    let db_path = db_path.as_path();
    let Ok(mut registry) = registry().lock() else {
        // A poisoned registry must not take the daemon down; an unshared cache
        // is merely slower, because nothing will fold records into it.
        return Arc::new(ProjectionCache::default());
    };
    registry
        .entry(db_path.to_path_buf())
        .or_insert_with(|| Arc::new(ProjectionCache::default()))
        .clone()
}

#[derive(Debug)]
struct Entry {
    /// Behind `Arc` so handing the set out is a pointer bump per record rather
    /// than a deep clone of every parsed JSON value. The same mutex serialises
    /// every session thread's `note_record`, so cloning megabytes under it put
    /// the write path for every streaming agent behind the readers.
    records: Vec<Arc<ProviderEventRecord>>,
    /// `identity_key` → position in `records`. A linear scan per streamed delta
    /// was the same quadratic shape as the one removed from the projection.
    index_by_identity: HashMap<String, usize>,
    bytes: usize,
    /// Bumped on every access, for least-recently-used eviction.
    touched: u64,
}

#[derive(Debug, Default)]
struct Inner {
    threads: HashMap<i64, Entry>,
    clock: u64,
    /// Threads whose retained set exceeded the byte budget. They are not
    /// re-admitted, so one enormous chat cannot thrash the cache.
    refused: HashSet<i64>,
}

#[derive(Debug)]
pub struct ProjectionCache {
    inner: Mutex<Inner>,
    capacity: usize,
    byte_budget: usize,
}

impl Default for ProjectionCache {
    fn default() -> Self {
        Self::new(DEFAULT_THREAD_CAPACITY)
    }
}

impl ProjectionCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            capacity: capacity.max(1),
            byte_budget: DEFAULT_THREAD_BYTE_BUDGET,
        }
    }

    /// For tests that need the budget to bite without building a huge chat.
    pub fn with_byte_budget(capacity: usize, byte_budget: usize) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            capacity: capacity.max(1),
            byte_budget,
        }
    }

    /// The thread's projection, loading and retaining its records on a miss.
    ///
    /// `load` is only called when the records are not already held, so the
    /// common case touches neither SQLite nor the JSON parser.
    pub fn projection(
        &self,
        thread_id: i64,
        load: impl FnOnce() -> Result<Vec<ProviderEventRecord>>,
    ) -> Result<ProviderProjection> {
        if let Some(records) = self.retained(thread_id) {
            let owned: Vec<ProviderEventRecord> =
                records.iter().map(|record| (**record).clone()).collect();
            return Ok(provider_projection_from_records(&owned));
        }
        let records = load()?;
        let projection = provider_projection_from_records(&records);
        self.admit(thread_id, records);
        Ok(projection)
    }

    /// Fold a freshly written record into the thread's retained set.
    ///
    /// A thread that is not held is left alone: its next pull loads the lot,
    /// which is cheaper than loading it here to append one row. Records are
    /// matched by `identity_key`, the same identity the store upserts on, so a
    /// re-sent event replaces rather than duplicates.
    pub fn note_record(&self, record: &ProviderEventRecord) {
        let Some(thread_id) = record.chat_thread_id else {
            return;
        };
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.clock += 1;
        let clock = inner.clock;
        let budget = self.byte_budget;
        let Some(entry) = inner.threads.get_mut(&thread_id) else {
            return;
        };
        entry.touched = clock;
        match entry.index_by_identity.get(&record.identity_key).copied() {
            Some(index) => {
                entry.bytes = entry
                    .bytes
                    .saturating_sub(record_bytes(&entry.records[index]));
                entry.records[index] = Arc::new(record.clone());
            }
            None => {
                entry
                    .index_by_identity
                    .insert(record.identity_key.clone(), entry.records.len());
                entry.records.push(Arc::new(record.clone()));
            }
        }
        entry.bytes += record_bytes(record);
        if entry.bytes > budget {
            inner.threads.remove(&thread_id);
            inner.refused.insert(thread_id);
        }
    }

    /// Drop a thread's retained records, so the next pull reloads them.
    ///
    /// Used where records are written without passing through the normal append
    /// path — `interrupt_active_turns_for_process` writes synthetic interrupt
    /// records straight to the table, and a cache that missed them would leave
    /// an interrupted turn rendering as still streaming.
    pub fn invalidate(&self, thread_id: i64) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.threads.remove(&thread_id);
        }
    }

    pub fn holds(&self, thread_id: i64) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.threads.contains_key(&thread_id))
            .unwrap_or(false)
    }

    fn retained(&self, thread_id: i64) -> Option<Vec<Arc<ProviderEventRecord>>> {
        let mut inner = self.inner.lock().ok()?;
        inner.clock += 1;
        let clock = inner.clock;
        let entry = inner.threads.get_mut(&thread_id)?;
        entry.touched = clock;
        Some(entry.records.clone())
    }

    fn admit(&self, thread_id: i64, records: Vec<ProviderEventRecord>) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.refused.contains(&thread_id) {
            return;
        }
        let bytes: usize = records.iter().map(record_bytes).sum();
        if bytes > self.byte_budget {
            inner.refused.insert(thread_id);
            return;
        }
        inner.clock += 1;
        let touched = inner.clock;
        let index_by_identity = records
            .iter()
            .enumerate()
            .map(|(index, record)| (record.identity_key.clone(), index))
            .collect();
        inner.threads.insert(
            thread_id,
            Entry {
                records: records.into_iter().map(Arc::new).collect(),
                index_by_identity,
                bytes,
                touched,
            },
        );
        while inner.threads.len() > self.capacity {
            let Some(coldest) = inner
                .threads
                .iter()
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(id, _)| *id)
            else {
                break;
            };
            inner.threads.remove(&coldest);
        }
    }
}

/// A record's rough retained size. Both JSON blobs are counted because both are
/// held parsed, and `raw_json` is the one that carries image data.
fn record_bytes(record: &ProviderEventRecord) -> usize {
    fn json_len(value: &serde_json::Value) -> usize {
        // Cheap structural estimate; serializing every record to measure it
        // would cost more than the cache saves.
        match value {
            serde_json::Value::Null => 4,
            serde_json::Value::Bool(_) => 5,
            serde_json::Value::Number(_) => 8,
            serde_json::Value::String(text) => text.len() + 2,
            serde_json::Value::Array(items) => 2 + items.iter().map(json_len).sum::<usize>(),
            serde_json::Value::Object(fields) => {
                2 + fields
                    .iter()
                    .map(|(key, value)| key.len() + 3 + json_len(value))
                    .sum::<usize>()
            }
        }
    }
    let base = record.identity_key.len() + 160;
    base + json_len(&record.normalized_payload) + json_len(&record.raw_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_events::{
        ProviderEventDraft, ProviderEventKind, ProviderEventPhase, ProviderEventStore,
    };
    use serde_json::json;

    fn draft(item_id: &str, phase: ProviderEventPhase, body: &str) -> ProviderEventDraft {
        ProviderEventDraft {
            provider: "claude".to_owned(),
            provider_event_id: Some(format!("evt-{item_id}")),
            provider_item_id: Some(item_id.to_owned()),
            provider_thread_id: Some("thread-1".to_owned()),
            provider_turn_id: Some("turn-1".to_owned()),
            parent_provider_item_id: None,
            parent_provider_thread_id: None,
            workspace_id: None,
            chat_thread_id: Some(1),
            process_id: Some(7),
            phase,
            kind: ProviderEventKind::Tool,
            provider_subtype: Some("tool_use".to_owned()),
            provider_sequence: Some(1),
            occurred_at_ms: 1_000,
            normalized_payload: json!({"title": "Bash", "body": body}),
            raw_json: json!({"name": "Bash", "input": {"command": body}}),
            schema_version: 1,
            adapter_version: "test".to_owned(),
        }
    }

    /// provider_events rows reference a repository, workspace, chat thread and
    /// process, so those have to exist before anything can be inserted.
    fn create_parent_rows(db_path: &std::path::Path, root: &std::path::Path) {
        let conn = rusqlite::Connection::open(db_path).unwrap();
        crate::storage::configure_workspace_db(&conn).unwrap();
        crate::storage::migrate_workspace_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO repositories (
                id, name, root_path, default_branch, remote_name, workspace_parent_path, created_at, updated_at
             ) VALUES (1, 'repo', ?1, 'main', 'origin', ?2, '1', '1')",
            rusqlite::params![
                root.join("repo").display().to_string(),
                root.join("workspaces").display().to_string(),
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (
                id, repository_id, name, path, branch, base_ref, port_base, status, created_at, updated_at
             ) VALUES (1, 1, 'berlin', ?1, 'feature/berlin', 'main', 3000, 'active', '1', '1')",
            rusqlite::params![root.join("workspaces/berlin").display().to_string()],
        )
        .unwrap();
        for thread_id in [1, 2] {
            conn.execute(
                "INSERT INTO chat_threads (
                    id, workspace_id, provider, title, status, created_at, updated_at
                 ) VALUES (?1, 1, 'claude', 'Claude', 'active', '1', '1')",
                [thread_id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO processes (
                id, workspace_id, chat_thread_id, kind, command, pid, log_path, status, started_at
             ) VALUES (7, 1, 1, 'session', 'claude', 999, '/tmp/session.log', 'running', '1')",
            [],
        )
        .unwrap();
    }

    fn seeded_store(dir: &std::path::Path) -> (ProviderEventStore, Vec<ProviderEventRecord>) {
        let db_path = dir.join("state.db");
        create_parent_rows(&db_path, dir);
        let store = ProviderEventStore::new(&db_path);
        let records = vec![
            // An open turn, so interrupt_active_turns_for_process has something
            // to act on.
            store
                .upsert_event(&ProviderEventDraft {
                    kind: ProviderEventKind::Turn,
                    provider_subtype: Some("turn".to_owned()),
                    ..draft("turn-1", ProviderEventPhase::Started, "turn")
                })
                .unwrap(),
            store
                .upsert_event(&draft("call-1", ProviderEventPhase::Started, "ls"))
                .unwrap(),
            store
                .upsert_event(&draft("call-2", ProviderEventPhase::Started, "cat README"))
                .unwrap(),
        ];
        (store, records)
    }

    #[test]
    fn cached_projection_equals_the_from_scratch_projection() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _) = seeded_store(temp.path());
        let expected = provider_projection_from_records(&store.list_for_chat_thread(1).unwrap());
        let cache = ProjectionCache::default();

        // First pull loads and retains; second must come from memory.
        let first = cache
            .projection(1, || store.list_for_chat_thread(1))
            .unwrap();
        let second = cache
            .projection(1, || panic!("should not reload a retained thread"))
            .unwrap();

        assert_eq!(first, expected);
        assert_eq!(second, expected);
    }

    #[test]
    fn a_record_arriving_out_of_order_lands_in_the_same_projection() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _) = seeded_store(temp.path());
        let cache = ProjectionCache::default();
        cache
            .projection(1, || store.list_for_chat_thread(1))
            .unwrap();

        // Two more rows, folded into the cache in the reverse order to the one
        // the store assigned them.
        let third = store
            .upsert_event(&draft("call-3", ProviderEventPhase::Started, "grep x"))
            .unwrap();
        let fourth = store
            .upsert_event(&draft("call-4", ProviderEventPhase::Started, "wc -l"))
            .unwrap();
        cache.note_record(&fourth);
        cache.note_record(&third);

        let cached = cache
            .projection(1, || panic!("should not reload a retained thread"))
            .unwrap();
        let expected = provider_projection_from_records(&store.list_for_chat_thread(1).unwrap());
        assert_eq!(cached, expected);
    }

    #[test]
    fn a_late_record_mutating_an_earlier_item_is_reflected() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _) = seeded_store(temp.path());
        let cache = ProjectionCache::default();
        let before = cache
            .projection(1, || store.list_for_chat_thread(1))
            .unwrap();
        let running = before
            .items
            .iter()
            .find(|item| item.id.contains("call-1"))
            .cloned()
            .expect("the first tool call is in the timeline");

        // Pad the thread, then complete the very first call. Its item keeps its
        // original sequence, so anything watermarking on item sequence would
        // miss this.
        for index in 0..20 {
            let padding = store
                .upsert_event(&draft(
                    &format!("pad-{index}"),
                    ProviderEventPhase::Started,
                    "pad",
                ))
                .unwrap();
            cache.note_record(&padding);
        }
        let completion = store
            .upsert_event(&draft("call-1", ProviderEventPhase::Completed, "ls"))
            .unwrap();
        cache.note_record(&completion);

        let after = cache
            .projection(1, || panic!("should not reload a retained thread"))
            .unwrap();
        let updated = after
            .items
            .iter()
            .find(|item| item.id.contains("call-1"))
            .expect("the first tool call is still in the timeline");
        assert_ne!(updated.status, running.status);
        assert_eq!(
            after,
            provider_projection_from_records(&store.list_for_chat_thread(1).unwrap())
        );
    }

    #[test]
    fn an_interrupt_written_outside_the_append_path_is_not_missed() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _) = seeded_store(temp.path());
        let cache = ProjectionCache::default();
        let before = cache
            .projection(1, || store.list_for_chat_thread(1))
            .unwrap();

        // interrupt_active_turns_for_process writes straight to the table, so
        // the cache is told to drop the thread rather than being handed rows.
        // Without this an interrupted turn renders as still streaming forever.
        let interrupted = store
            .interrupt_active_turns_for_process(7, "interrupted by test")
            .unwrap();
        assert!(
            interrupted > 0,
            "the fixture must have an active turn to interrupt, or this proves nothing"
        );
        let fresh = provider_projection_from_records(&store.list_for_chat_thread(1).unwrap());
        assert_ne!(
            fresh, before,
            "the interrupt must change the timeline, or this proves nothing"
        );

        cache.invalidate(1);

        let after = cache
            .projection(1, || store.list_for_chat_thread(1))
            .unwrap();
        assert_eq!(after, fresh);
    }

    #[test]
    fn an_evicted_thread_rebuilds_from_the_store() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _) = seeded_store(temp.path());
        let cache = ProjectionCache::new(1);
        cache
            .projection(1, || store.list_for_chat_thread(1))
            .unwrap();

        // A second thread evicts the first from a one-slot cache.
        let other = ProviderEventDraft {
            chat_thread_id: Some(2),
            ..draft("other-1", ProviderEventPhase::Started, "echo hi")
        };
        store.upsert_event(&other).unwrap();
        cache
            .projection(2, || store.list_for_chat_thread(2))
            .unwrap();

        assert!(!cache.holds(1));
        let reloaded = cache
            .projection(1, || store.list_for_chat_thread(1))
            .unwrap();
        assert_eq!(
            reloaded,
            provider_projection_from_records(&store.list_for_chat_thread(1).unwrap())
        );
    }

    #[test]
    fn a_thread_over_the_byte_budget_is_served_from_the_store() {
        let temp = tempfile::tempdir().unwrap();
        let (store, _) = seeded_store(temp.path());
        // A budget small enough that two ordinary rows blow it, standing in for
        // a chat full of screenshots.
        let cache = ProjectionCache::with_byte_budget(8, 64);

        let projection = cache
            .projection(1, || store.list_for_chat_thread(1))
            .unwrap();

        // Correct answer, just not retained — memory stays bounded.
        assert_eq!(
            projection,
            provider_projection_from_records(&store.list_for_chat_thread(1).unwrap())
        );
        assert!(!cache.holds(1));
    }
}
