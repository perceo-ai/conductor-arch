# GTK Refresh Refactor Map

Current summary as of 2026-07-24. This file records the contract, not every
historical call-site migration.

## Goal

Routine GTK updates must refresh the smallest mounted owner of changed data.
Whole-app and whole-workspace rebuilds are reserved for startup, selection,
inventory/lifecycle, settings, and explicit debug recovery.

## Removed Broad Paths

Do not reintroduce these for routine updates:

- `RefreshScope::All`
- `RefreshScope::Workspace`
- `WorkspaceRefreshTarget::Shell`
- shell fallback from missing child handlers
- sidebar/dashboard/history fanout for runtime, chat message, terminal, or
  review child changes

`RefreshHub::debug_full_refresh()` is the only full refresh path and is gated
by `ARCHDUCTOR_GTK_DEBUG_FULL_REFRESH`.

## Event Shape

Use typed payload events with workspace/thread/process/file ids where possible.
Important families:

- workspace header/status/branch/diff stats/lifecycle/metadata
- workspace runtime and per-process runtime changes
- terminal and terminal-buffer changes
- review/check/comment changes
- chat lifecycle, tab, session status, messages, message append/update, and
  timeline tail changes
- right-panel file list, selected file, and diff preview changes
- settings section changes

Missing small listeners should be a no-op, not a reason to rebuild a broad
surface.

## Scoped Listener Model

`RefreshHub` has grouped updater callbacks for mounted surfaces and RAII
subscriptions for keyed row/card ownership. Dropping the subscription
unregisters it. Listener filters must match exact event type and key.

Current examples:

- workspace nav rows listen for header/status/branch/metadata
- workspace diff stat labels listen for
  `WorkspaceDiffStatsChanged { workspace, additions, deletions }`
- right-panel child handlers own file list, selected file, and diff preview
- chat tabs and chat surface own chat lifecycle/message changes

## Verification Anchors

Keep tests in `crates/gtk-app/src/refresh.rs` as the guardrail for fanout and
debug-only behavior. When adding a new refresh event, test that routine sources
do not call broad mount/full refresh paths.
