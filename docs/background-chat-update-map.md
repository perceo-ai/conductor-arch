# Background Chat Update Map

Current summary as of 2026-07-24. This file is intentionally short; use code
search for call-site detail.

## Purpose

Background chat updates keep hidden running chats, queue state, nav summaries,
and selected chat surfaces current without loading every hidden timeline.

## Mechanisms

- `crates/gtk-app/src/main.rs` installs a two-second sampler for lightweight
  running chat markers.
- `crates/gtk-app/src/background_sync.rs` loads and diffs running-thread
  summaries, then emits scoped refresh events.
- `crates/gtk-app/src/background_chat.rs` owns the app-lifetime hidden-chat
  Archcar bridge, queue wake planner, queue-cache sync, and PR refresh trigger.
- `crates/core/src/archcar/server.rs` owns durable FIFO queue drain from ready
  managed sessions.
- `crates/core/src/workspace.rs` stores queue rows and exposes running chat
  summary queries.
- `crates/gtk-app/src/session_surface.rs` owns visible chat rendering and the
  selected chat Archcar bridge.

## Background Sampling

`WorkspaceStore::list_running_chat_thread_summaries` samples only lightweight
markers: workspace, chat thread id, title, provider, thread status, latest
message id, latest provider event sequence, running session id, and updated
timestamp. It must not load message bodies, transcripts, diffs, PR state, or
terminal logs.

The GTK timer skips when a previous sample is still in flight. It emits
message refreshes when latest message id or provider event sequence changes,
and lifecycle refreshes when a thread appears/disappears or title/provider/
status/session id changes. Timestamp-only changes are ignored. Duplicate
message events collapse per `(workspace, thread_id)`; duplicate lifecycle
events collapse per workspace.

## Hidden Queue Runner

Archcar is the queue source of truth. GTK writes queue requests through Archcar
and mirrors rows for immediate UI. Archcar removes a row before provider
delivery; on delivery failure it restores the row at the front or surfaces the
restore failure.

The background runner wakes on Archcar events with a short debounce and also
ticks once per second. Each pass drains bridge events/responses, emits scoped
refreshes for affected chats/workspaces, scans durable queued-thread ids,
loads lightweight queue candidates in a background job, and ensures or probes
managed sessions so Archcar can drain hidden queues when idle and ready.

The selected visible chat still owns optimistic UI, interrupt controls, and
immediate sends. Queued auto delivery always goes through Archcar.

## Refresh Routing

`WorkspaceChatMessagesChanged` updates chat tabs and the selected chat surface
only when the workspace/thread matches. `WorkspaceChatLifecycleChanged` updates
sidebar/dashboard/history summaries, chat tabs, and selected chat nav. Neither
route should rebuild Projects or the whole workspace shell.
