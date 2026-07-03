# Task 3 Report

- Status: complete
- Commit: `workspace: persist codex parser cursor and chat events`
- Files changed:
  - `crates/core/src/workspace.rs`
  - `.superpowers/sdd/task-3-report.md`
- Summary:
  - Added persistent Codex parse cursors keyed by `process_id`.
  - Added persistent `chat_events` storage with JSON payloads and idempotent duplicate detection.
  - Added shared monotonic `chat_timeline_seq` allocation and `timeline_seq` on chat messages/events for cross-table ordering.
  - Added persistence tests for cursor/event separation, shared timeline ordering, and idempotent event insertion.
- Tests run:
  - `cargo test -p linux-archductor-core codex_parser_cursor_and_events_persist_separately_from_messages -- --nocapture` -> passed
  - `cargo test -p linux-archductor-core chat_messages -- --nocapture` -> passed
  - `cargo test -p linux-archductor-core workspace::tests::chat -- --nocapture` -> passed
- Concerns:
  - Existing `chat_messages` rows are not backfilled with `timeline_seq`; they continue to sort via `COALESCE(timeline_seq, id)` until rewritten.

## Review fix pass

- Status: complete
- Files changed:
  - `crates/core/src/workspace.rs`
  - `.superpowers/sdd/task-3-report.md`
- Summary:
  - Made chat-message adjacent dedupe inspect the latest shared timeline item across `chat_messages` and `chat_events`.
  - Made chat-event insertion idempotent inside a write transaction so duplicate inserts do not consume a new timeline sequence.
  - Added tests for mixed message/event dedupe and `payload_json` round-trip coverage.
- Tests run:
  - `cargo test -p linux-archductor-core chat_messages -- --nocapture` -> passed
  - `cargo test -p linux-archductor-core codex_parser_cursor_and_events_persist_separately_from_messages -- --nocapture` -> passed
  - `cargo test -p linux-archductor-core chat_events_round_trip_payload_json_for_file_changes -- --nocapture` -> passed
  - `cargo test -p linux-archductor-core chat_events_are_idempotent_without_allocating_new_timeline_sequence -- --nocapture` -> passed
- Concerns:
  - None beyond the pre-existing `timeline_seq` backfill note above.

## Upgrade backfill fix

- Status: complete
- Files changed:
  - `crates/core/src/workspace.rs`
  - `.superpowers/sdd/task-3-report.md`
- Summary:
  - Backfilled `chat_messages.timeline_seq` during migration for rows that still had `NULL`, ordered by `created_at` and `id`.
  - Kept existing non-null timeline sequence values unchanged.
  - Added a regression test that simulates an upgraded database with stale `NULL` message sequences, verifies migration backfill, and checks that a message after an intervening event is still persisted.
- Tests run:
  - `cargo test -p linux-archductor-core chat_messages_backfill_null_timeline_seq_before_event_dedupes -- --nocapture` -> passed
  - `cargo test -p linux-archductor-core chat_messages -- --nocapture` -> passed
- Concerns:
  - None.
