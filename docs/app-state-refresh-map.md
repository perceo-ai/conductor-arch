# AppState And Refresh Map

Current summary as of 2026-07-24. This file is intentionally short; use code
search for call-site detail.

## Ownership

`AppState` is GTK-only hot UI state. It is not durable project, workspace,
session, chat, terminal, PR, check, or queue state. Durable state lives in
`crates/core` stores and SQLite. Archcar owns managed session runtime and
queued chat delivery.

Primary files:

- `crates/gtk-app/src/state.rs`: `AppState`, snapshots, watchers, optimistic
  workspace/chat phases, composer queue cache, navigation history.
- `crates/gtk-app/src/refresh.rs`: `RefreshHub`, typed `RefreshEvent`s,
  scoped listeners, refresh metrics.
- `crates/gtk-app/src/main.rs`: creates `AppState`, bridges refresh requests,
  installs startup and background refresh paths.
- `crates/gtk-app/src/background_chat.rs`: hidden chat Archcar events, queue
  wakeups, scoped chat/review refresh.
- `crates/gtk-app/src/workspace_command_center.rs` and
  `crates/gtk-app/src/session_surface.rs`: workspace tab state, selected chat,
  selected session, staged prompts, visible chat rendering.

`AppState` does not appear in `crates/core` or `crates/cli`.

## State Slices

`AppStateSnapshot` stores selected workspace/page/tabs, selected chat target,
selected agent session, staged prompt text, optimistic workspace/chat phases,
composer queue cache, pending target ids, navigation history, and immutable app
paths. Workspace changes clear selected chat, selected target, selected session,
staged review prompt, and pending prompt to prevent cross-workspace leakage.

## Refresh Model

Local UI mutations emit `AppStateEvent`s. Durable data changes emit typed
`RefreshEvent`s through `RefreshHub`.

Routine refresh should update the smallest mounted owner:

- chat messages -> chat surface and chat tabs
- chat lifecycle -> sidebar/dashboard/history chat summaries and chat tabs
- runtime/terminal -> runtime or terminal surface
- review/checks -> review/checks surface
- workspace metadata/diff -> keyed nav row/listener
- right-panel file/diff changes -> right-panel child handlers

Full refresh is debug recovery only through `RefreshHub::debug_full_refresh()`
and `ARCHDUCTOR_GTK_DEBUG_FULL_REFRESH`. Do not reintroduce routine
`RefreshScope::All`, whole-workspace shell refresh, or broad fallback refreshes
for child events.

## Hot Flows

Workspace creation writes optimistic phases, navigates as soon as the row
exists, then updates phase on success/failure. Chat creation allocates a
pending target, queues pending input there, resolves it to a real thread, moves
queued input, and wakes Archcar to drain when ready.

Composer sends use the selected chat target. Pending targets queue in GTK until
the thread exists. Real busy/startup-blocked sessions queue through Archcar and
mirror rows in the GTK cache. Ctrl+Enter attempts immediate managed-harness
delivery. Queue add/list/remove responses and `ChatQueueUpdated` events
reconcile the visible cache with durable Archcar queue ids.
