# Opt-in tool approval for Claude threads

Date: 2026-09-21
Status: approved, not yet implemented

## Problem

Archductor ships a complete tool-approval UI that never appears. Every
Claude agent runs fully unattended, and a user who wants to supervise one
thread has no way to ask for it.

The approval loop itself is already built and conformance-tested:

- `claude_stream.rs:503` turns a `can_use_tool` control request into
  `HarnessEffect::InteractionRequested`.
- `session.rs:735` stores the interaction and emits
  `ProviderInteractionRequested`.
- `Interactions.tsx` renders `InteractionBanner` above the composer with
  approve / deny / answer actions.
- Resolving sends `control_response_for` back down the same stdio channel
  (`claude_stream.rs:668`).

What keeps it dark is the launch configuration. `harness.rs` hardcodes
`claude_permission_mode()` to `bypassPermissions`, always adds
`--dangerously-skip-permissions`, and `normalize_agent_harness_options`
overwrites any requested `approval_mode` with `FORCED_APPROVAL_MODE`
("never"). Under `bypassPermissions` the CLI never raises `can_use_tool`,
so the loop has nothing to carry.

A separate PreToolUse hook (`claude_hooks.rs`) was a second, redundant
implementation of the same feature. It answered `defer` to every tool call
with no channel to ever resolve the deferral, which killed the turn on its
first tool call. PR #126 removed that answer; this design does not revive
it. The hook was a dead end, not a foundation.

## Decisions

Two product calls were made during design:

- **Bypass stays the default.** Nothing changes for an existing workspace
  unless its user opts in. Supervision is per thread, opt-in.
- **The choice persists per thread.** A user who asks to supervise a thread
  stays supervising it across session restart, model switch, effort switch
  and app relaunch, until they turn it off.

## Verification that shaped the design

Probed against the real `claude` CLI (fable-5, isolated settings file):

- Launched with `--permission-mode bypassPermissions
  --dangerously-skip-permissions`, an in-band `set_permission_mode` to
  `default` is **accepted**, `can_use_tool` then fires for a
  non-allowlisted Bash command, and answering it with a `control_response`
  completes the turn (`stop_reason=end_turn`, zero permission denials).
- Without the in-band switch, the same prompt runs the tool with no ask.

This is why no launch-argument change is needed. The risky, load-bearing
part of the configuration stays untouched.

## Approach

Compute the permission mode from one helper, consulted everywhere a Claude
session's mode is decided.

Three sites decide that mode today:

| Site | Today |
| --- | --- |
| `session.rs:1084` launch args | `plan_mode ? "plan" : "bypassPermissions"` |
| `session.rs:1300` resume args | always `"bypassPermissions"` |
| `server.rs:3959` plan-mode toggle | `SessionKind::CLAUDE => "bypassPermissions"` |

The managed-session path already computes the mode dynamically — that is how
plan mode works — so this needs no change to argument building and no change
to `harness.rs`.

The third site is why a re-apply-after-init approach is not enough. Leaving
plan mode sets the session straight back to `bypassPermissions` without a
restart, so an init hook never fires and the user's supervision is silently
switched off mid-thread. A shared helper closes that hole because every site
re-reads the same source of truth.

```rust
// plan mode wins; then the thread's opt-in; then today's default
fn claude_permission_mode_for_thread(store: &RuntimeSessionStore, thread_id: i64) -> String
```

This also removes `--dangerously-skip-permissions` for an opted-in thread
without touching argument code: `build_claude_stream_args:913` adds that flag
only when the mode is `bypassPermissions`.

Two approaches were rejected:

- **Re-apply in-band after every harness init.** Covers start, restart, model
  switch and relaunch, but not the plan-mode exit above, which changes the
  mode with no restart. It also adds a second mechanism alongside the launch
  computation that already exists.
- **Hybrid** (launch args initially, in-band for changes). Same gap, more
  branching.

Probe evidence that both the launch path and the in-band path work is in
"Verification that shaped the design" above; the helper uses the launch path,
and the existing `SetSessionPermissionMode` RPC continues to serve
mid-session toggles.

## Design

### Data model

One column on `chat_threads`, following the `plan_mode` precedent at
`storage.rs:562`:

```
ensure_column(conn, "chat_threads", "approval_mode",
    "ALTER TABLE chat_threads ADD COLUMN approval_mode TEXT")
```

`NULL` means unset, which is today's behavior (`bypassPermissions`). Every
existing row reads as unset, so there is no backfill and no behavior change.

The column stores the Claude mode string rather than a boolean, so
`acceptEdits` can be exposed later without a second migration. The UI
exposes only on/off for now.

`approval_mode` stays separate from `plan_mode`. They are orthogonal — plan
mode governs whether the agent builds, this governs who approves tools — and
merging them would rework a path that currently works.

### Backend

1. **One helper.** `claude_permission_mode_for_thread(store, thread_id)` in
   `archcar::session`, beside the existing `CLAUDE_PLAN_PERMISSION_MODE` and
   `CLAUDE_DEFAULT_PERMISSION_MODE` constants. Order: plan mode wins, then the
   thread's `approval_mode`, then `CLAUDE_DEFAULT_PERMISSION_MODE`.
2. **Three call sites** use it: launch args (`session.rs:1084`), resume args
   (`session.rs:1300`), and the plan-mode toggle (`server.rs:3959`).
3. **Persist.** `SetSessionPermissionMode` (`server.rs:701`) currently only
   forwards `HarnessControl::SetPermissionMode` to the harness. Write
   `chat_threads.approval_mode` for the session's thread before forwarding, so
   a mid-session toggle survives the next restart.
4. **Nothing else.** The rest of the loop already exists.

Claude-only to start. `SetPermissionMode` is `Unsupported` on the ACP adapter
(`acp.rs:518`) and means something different on Codex; threads on those
providers ignore the column. One provider that works beats a leaky abstraction
across three.

### UI

A toggle in `Composer.tsx` beside the existing plan-mode toggle (`:699`),
using the same component and the same shape. It reads
`chatStore.slice(threadId).approvalMode` and sends
`set_session_permission_mode` with
`chatStore.slice(threadId).session.session_id`.

Two states: off is `bypassPermissions`, on is `default`. Labeled "Ask before
tools". Off by default.

When a thread has no running session the toggle still flips and persists to
the thread; it takes effect at next start. That is what per-thread
persistence buys.

### Error handling

- **No live session:** persist the column, skip the harness control, do not
  error.
- **Non-Claude provider:** persist; the adapter's existing `Unsupported`
  plan is surfaced the same way plan mode's is today.
- **Stored mode is unreadable:** fall back to
  `CLAUDE_DEFAULT_PERMISSION_MODE` so the session still starts, and log a
  warning. The spec previously called for surfacing this in the thread
  timeline via `append_runtime_provider_event`; that is not reachable from
  the helper, which runs at launch and resume before a session exists to
  attach an event to. A read failure of this column means the database is
  unavailable, in which case session startup fails on its own path and is
  reported there — so the warning is not the only signal the user gets.
- **App closed with a prompt pending:** unchanged from today's behavior for
  plan approvals. The interaction row stays `Pending`, the banner returns on
  reopen, and the CLI is still blocked on its `control_request`. A known
  rough edge, explicitly out of scope here.

### Testing

- **Unit:** the migration adds the column defaulting to NULL;
  `SetSessionPermissionMode` writes it; `claude_permission_mode_for_thread`
  returns plan mode ahead of the opt-in, the opt-in ahead of the default, and
  the default when the column is NULL.
- **Regression for the plan-exit hole:** leaving plan mode on an opted-in
  thread resolves to the opt-in mode, not `bypassPermissions`.
- **Adapter:** `SetPermissionMode` produces the `set_permission_mode`
  control request — extends the existing test at `claude_stream.rs:2555`.
- **Integration:** drive a real session through a dev-home daemon
  (`scripts/dev-instance-env.sh` with `ARCHDUCTOR_DEV_HOME`), toggle on,
  send a prompt that needs a tool, assert a `ProviderInteractionRequested`
  appears and that resolving it lets the turn finish. This is the test that
  would have caught the original class of bug, where unit tests all passed
  while every thread died.

## Out of scope

- Reviving the PreToolUse hook or building hook-to-daemon IPC.
- Approval support for Codex, ACP, or other providers.
- A risk-tiered policy (ask only for network or destructive commands).
- Resolving an interaction while the app is closed.
