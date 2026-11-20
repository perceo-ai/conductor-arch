# Keeping every chat warm without cooking the laptop

Design, 2026-11-19.

## Intent and the why

Running many agent sessions at once is the whole point of Archductor, and
today it is the thing that makes the machine hot. The user reports the fans
spinning up with a handful of concurrent sessions.

The reflex fix — refresh less when nobody is looking — is the wrong one here,
and the user said so explicitly: every chat should keep refreshing in the
background, so the sidebar tells the truth about work the user is not watching
and so switching into a chat shows its context immediately rather than
loading it.

So the goal is not *less* refreshing. It is making a refresh cost what the
change actually was, instead of what the whole thread and the whole workspace
inventory happen to be.

## What it costs today

Two independent hogs, both O(everything) per notification.

**1. The inventory refresh shells out to git, per workspace, per call.**

`ArchcarRequest::ListWorkspaces` (`crates/core/src/archcar/server.rs:1262`)
calls `workspace_summaries` (`server.rs:5831`), which per *active* workspace
runs:

- `git rev-parse --abbrev-ref --symbolic-full-name @{u}` — `workspace.rs:6308`
- `git rev-list @{u}..HEAD` and `git rev-list HEAD..@{u}` — same function
- `git merge-base` plus `git diff --shortstat` via
  `diff_stats_against_base` — `workspace.rs:4675`
- `git status --short` via `changed_files` — `workspace.rs:4071`

That is roughly six git subprocesses per active workspace, with no cache, on
every single call. The renderer then fires that call **uncoalesced** from six
different events in `desktop/src/store/reducer.ts`: `turn_completed`,
`session_started`, `session_exited`, `chat_queue_updated`,
`background_task_updated` and `task_updated`. Ten busy workspaces turn a
normal streaming minute into a sustained storm of git processes, each one
touching the disk.

**2. Every streamed token re-reads the entire thread.**

`archcar` emits `SessionMessagesUpdated { thread_id }` once per provider
event — per token, in practice. The renderer answers each one with four
full-thread RPCs: `get_chat_snapshot`, `get_chat_projection`,
`list_provider_interactions` and `get_chat_plan`.
`lib/refreshCoalescer.ts` rate-limits that to ten runs a second *per thread*,
which is a ceiling on frequency and does nothing about the size of each run.

Daemon-side, `GetChatProjection` (`server.rs:1360`) reads **every**
`provider_events` row for the thread through `list_for_chat_thread`, re-runs
`provider_projection_from_records`, re-filters it and re-serializes the whole
timeline.

So steady-state cost is about `transcript length × active threads × 10/s`, on
both sides of the socket. The longer a chat runs, the more each tick costs.

## Measured baseline

Numbers in `docs/evidence/2026-11-19-concurrent-chat-perf-baseline.md`,
reproducible with `scripts/perf/inventory-cost.mjs` and
`scripts/perf/chat-rpc-slope.mjs`. Debug builds, so absolute figures are
pessimistic; the slopes are the finding. In short:

- `list_workspaces` costs **283ms at one workspace and 2262ms at ten**, six git
  subprocesses per active workspace, linear, nothing cached — on a repository
  with one commit and an empty worktree.
- `get_chat_projection` ships **~0.36kB per row** — 34kB at 100 rows, 1.4MB at
  4000 — and takes between **0.5s and 5s at 4000 rows** across repeat runs. The
  byte figure is clean; the timing is noisy enough (debug binaries, busy
  machine, few samples) that the *shape* of the curve is not yet established.
  It is slow and it grows with transcript length; whether it is superlinear is
  an open question, not a finding.
- The other three per-tick RPCs are flat and negligible. `get_chat_snapshot`
  with `include_provider_events: false` is ~2kB regardless of transcript
  length.

One thing in the design follows directly from this and was not obvious before
measuring: the snapshot is **not** a target, so Phase 1 leaves it alone.

A suspected second defect is deliberately left as a question. If the
projection really is superlinear in record count, caching would hide it rather
than fix it, and it would resurface on every cold build — so it is worth
knowing. `render_provider_event_projection` has two plausible candidates: the
`background_agent_folds.iter().any(...)` scan per event
(`provider_projection.rs:370`), which is O(folds) per record, and the repeated
body clone-and-append on merge. But the measurement that suggested it was
noisy, and the synthetic row multiplication the bench uses inflates background
card counts in a way production may not. Establish the curve on release
binaries and an idle machine before spending anything on it.

**What is already fine.** The renderer itself is not the problem, which is
worth saying because it was the initial suspicion. The Solid stores write
narrow paths, `reconcile(key: "id")` keeps row identity, and `Timeline`
windows its rows (`TIMELINE_WINDOW_SIZE`). The waste is upstream of the DOM.

## Goals

- Background chats stay warm — every thread's timeline and the sidebar keep
  updating whether or not the chat is on screen.
- Switching into a chat shows its context with no load wait.
- The cost of a streaming turn is proportional to the new events in it, not to
  the length of the thread or the number of workspaces.
- Git subprocess count stops scaling with notification volume.
- All three clients stay in line: CLI, Electron desktop, and iOS.

**iOS is already the well-behaved client, and is the pattern to copy.** An
earlier draft claimed iOS caused the same storm. It does not.
`WorkspacesStore.swift` already coalesces inventory refreshes behind a 250ms
quiet window (`refreshSoon` / `drainCoalescedRefreshes`,
`refreshQuietWindow = .milliseconds(250)`) and already excludes
`sessionMessagesUpdated` and `chatQueueUpdated` from the set of events that
invalidate the list — with a comment explaining that refetching per streamed
message "would put a full round-trip behind each token of an agent's reply".
`ChatStore.refreshKind(for:thread:)` pulls the timeline only for the thread on
screen.

So 1d is the desktop catching up to iOS, not the other way round, and the iOS
work shrinks to adopting the projection cursor once it exists. The desktop
coalescer should be modelled on `refreshSoon`, including the 250ms window —
which is independent support for the interval chosen below.

One divergence noted and deliberately kept: iOS pulls the timeline only for
the visible thread, which is the policy the non-goals reject for the desktop.
The phone's reason is sound and different — one visible conversation, and a
metered link — so it stays.

## Non-goals

- Gating, throttling or deprioritising off-screen threads. Explicitly
  rejected: it trades away the thing the user asked for.
- Reworking the renderer's store or timeline rendering. Measurements say it is
  not the bottleneck; leave it alone.
- Changing what the timeline *shows*. This is a cost change, not a behaviour
  change. Projection output must be byte-identical.
- Reducing provider event volume, or changing how events are stored.

## Anti-goals

Things that would make this a failure even if the CPU number improved:

- Any staleness the user can notice. A cached sidebar that lags reality, or a
  thread that misses an event and silently shows a short timeline, is worse
  than a hot laptop. Correctness beats the win every time.
- A cache that can diverge from the database with no way back. Every cache
  here needs a path that reconstructs it from the store.
- Making a long chat correct but a short one slower.

## Constraints

- `ServerState` (`server.rs:63`) is behind one `Mutex`. A git call or a
  projection rebuild must not run while that lock is held, or the daemon
  serialises every client behind it.
- Provider events can arrive out of order and a late record can mutate an
  *earlier* timeline item: `provider_projection_from_records` merges lifecycle
  events, computes elapsed turn time, drops echoed user messages, assigns
  canonical ids and nests subagents. Incremental projection is therefore not
  "append the new item" — it is "recompute and diff", with state kept so the
  recompute is cheap.
- Clients reconnect, and a daemon can be replaced mid-session
  (`daemonEpoch.ts`). Any delta stream needs a resync that does not depend on
  having seen every prior message.
- Both surfaces read these RPCs: `crates/cli/src/main.rs` calls
  `get_chat_projection` too. Protocol changes must keep the old request shape
  working.

## Approaches considered

**Renderer-only tuning** — longer coalescing interval, stop pulling
plan/interactions/images every tick, coalesce the inventory refreshes. One
day's work, no protocol change, maybe 5–10×. Rejected as the whole answer: the
git storm and the O(thread) projection survive, so background freshness and
cost stay in direct tension, which is exactly the trade the user refused. Parts
of it survive as cheap wins inside Phase 1.

**Full push — daemon broadcasts projection and workspace deltas; renderer
stops polling.** The endpoint worth having: a background thread then costs
exactly its stream. But a diff needs retained state, so it requires the
daemon-side caches anyway, plus new event types and a resync path. Doing it
first means landing the caches and the protocol reshape in one reviewable
lump.

**Daemon caches, renderer keeps pulling** (chosen for Phase 1) — the daemon
keeps each thread's projection and each workspace's git facts in memory and
serves the existing RPCs from them. Nearly all of the win, no protocol
reshape, CLI unaffected, and it is the foundation the push model needs.

**Decision: Phase 1 then Phase 2, as separate pull requests.** Phase 1 holds
nearly all the win and de-risks Phase 2; Phase 2 then removes the residual
polling floor. Phase 2 does not start until Phase 1's numbers are in.

## Phase 1 — make a refresh cheap

### 1a. Cache the projection in the daemon

Keep a per-thread projection cache in the daemon, built from
`provider_events` once and then maintained as new records are written.

**Hook the writers, not the emit sites.** The emit sites in `session.rs` all
funnel through `RuntimeSessionStore::append_provider_event`
(`crates/core/src/runtime_session_store.rs:95`), which is the right hook — but
it is not the only writer. `ProviderEventStore::interrupt_active_turns_for_process`
writes synthetic interrupt records directly (`provider_events.rs:522`, called
from `server.rs:149` and `server.rs:7019`), and those mutate the timeline. A
cache hooked only at the emit sites would leave an interrupted turn rendering
as still streaming — a stuck spinner, which is the user-visible staleness the
anti-goals forbid. Both writers are in-process, and no out-of-process writer to
the table was found, so one in-process hook covering both is sufficient.

**Retain projected events, not raw records.** `ProviderEventRecord` holds both
`normalized_payload` and `raw_json` as parsed `Value`s, and `raw_json` is where
base64 image data lives — a screenshot-heavy thread is tens of megabytes of
retained JSON, multiplied by the retained-thread cap, in a daemon that runs as
a long-lived service. So the cache retains the *projected* intermediate
(`ProviderProjectionEvent`), not the records. The equality test is therefore
"projection rebuilt from retained projected events equals projection built from
scratch from the rows", which is what the test in Verification must assert.

`GetChatProjection` serves from the cache: no SQLite scan, no re-projection.
On a miss (first access, new daemon, evicted entry) it builds from the store
as it does today — so the cache is pure optimisation and never the source of
truth.

Correctness over cleverness, given the merge semantics above: retain the
parsed records per thread and recompute the projection from them on change,
rather than trying to patch individual items. That keeps
`provider_projection_from_records` the single definition of the timeline —
output stays byte-identical — while dropping the SQLite read and the JSON
re-parse of every row, which is where the memory note on this path says the
money goes. Whether the recompute is further narrowed is left to the builder,
behind a test that proves equality with the from-scratch projection.

Eviction: bounded by recency, with a cap on retained threads. A cold thread
rebuilds on demand. The exact cap is the builder's call.

### 1b. Withdrawn — images already left the projection

This section originally claimed the projection inlines image bytes. It does
not: `ArchcarProjectionImage` carries only `media_type` and a decoded size
(`protocol.rs:1744`), and `GetChatImage` has served bytes by card id and index
since #246, explicitly so that "a chat full of screenshots still refreshes in
kilobytes". The claim was wrong and the deliverable is dropped. The measured
0.36kB per row confirms there is no image bulk in the payload.

One real residue, demoted to a cleanup: `GetChatImage` re-reads every record
for the thread to serve one image (`server.rs:~1403`). Cheap per image, and it
falls out for free once 1a has the records in hand.

### 1c. Cache the workspace git facts

Same shape, for `workspace_summaries`: cache the git-derived fields
(ahead/behind, diff stats, changed-file count) per workspace, computed off the
`ServerState` lock. Serve `ListWorkspaces` from the cache.

Invalidation is the whole design here, and staleness is an anti-goal, so it is
belt and braces:

- Invalidate a workspace's entry on events that can change its git state —
  session activity in it, a commit, a checkout, a branch or PR operation.
- Re-derive on a bounded interval as a floor, so an unforeseen path cannot
  pin a stale row forever. An agent editing files does not emit an event per
  write, so the interval is what makes the diff badge move during a turn.
- Recompute in the background and publish the result, so no client request
  ever waits on git.

The interval is a cost/freshness dial; pick it from the bench, not from
taste.

**Cold cache.** `changed_files`, `diff_additions` and `diff_deletions` are
non-`Option` on the wire (`protocol.rs:1686`), so on a cold cache — daemon
start, new workspace, post-eviction — there are only three honest options:
serve zeros (the sidebar claims every workspace is clean right after launch,
then flickers; that is exactly the forbidden staleness), make the fields
optional (protocol change across three clients, against Phase 1's premise), or
persist the last computed values and serve those until the recompute lands.

**Decision: persist them.** The values are already derived and tiny, so a
column apiece plus a migration buys a cold start that shows the last truth
instead of a lie, and no request ever blocks on git. A brand-new workspace has
no last value, but it also has no changes, so zeros are correct there rather
than merely convenient.

### 1d. Narrow and coalesce the renderer's refreshes

In `desktop/src/store/reducer.ts` (iOS already does the first two):

- Route every `workspacesStore.refresh()` / all-workspace thread refresh
  through a coalescer. One trailing refresh per interval, not one per event.
- Drop `session_messages_updated` and `chat_queue_updated` from the set of
  events that trigger an inventory refresh at all, matching
  `WorkspacesStore.invalidates(_:)`. A streamed token cannot change the
  workspace list.
- Raise `CHAT_REFRESH_INTERVAL_MS` from 100 to 250 — roughly four ticks a
  second instead of ten. This applies to *every* thread equally, focused
  included; it is not the off-screen deprioritisation the non-goals reject. A
  flat 2.5× for one line, taken on top of the caching work rather than instead
  of it. Four updates a second is still well past reading speed, and turn
  boundaries continue to flush immediately, so a finished turn never waits.
- Take `get_chat_plan` and `list_provider_interactions` off the per-token
  path — demoted to a tidy-up, since both measured flat and negligible. Plan
  state already arrives as `chat_plan_updated` and interactions as
  `provider_interaction_requested` / `_resolved`; the per-tick pull exists to
  cover state raised before the window opened, so keeping it on thread open,
  reconnect and turn boundaries is enough.
- Add a cursor to the projection request so a streaming tick ships changed
  items instead of the whole timeline.

**Cursor semantics — settled here, because the obvious reading is wrong.**
"Items with `sequence` greater than the cursor" would be silently incorrect in
this codebase. An item's `sequence` is fixed by its *first* record
(`provider_projection.rs:355`), and a later record for the same canonical id
mutates that item in place while keeping the old sequence: status
running→completed, appended body, `timeline_seq`, `background_agent`, turn
elapsed time. Every one of those changes sits *below* a watermark the client
has already passed, so the client would never see them. Items can also vanish
or merge — `drop_echoed_user_messages`, `fold_background_agent_cards`, and the
relevance filter in `server.rs:1360` — and a merge-by-id client has no way to
learn about a deletion.

So the cursor is a watermark over `ProviderEventRecord.received_sequence`, not
over item sequence, and the response carries two things:

1. every item that *any* record newer than the cursor touched, whatever its
   own sequence, and
2. the full ordered list of item ids — ids only, which is cheap — so the client
   can detect removals and reordering by set difference.

The client's new cursor is the highest `received_sequence` the daemon
considered. This stays stateless on the daemon side: no per-connection
retained projection, so Phase 2's machinery does not leak into Phase 1. A
full pull remains available and is what thread open uses.

On a daemon replacement the client's cursor is meaningless, so a cursor the
daemon cannot honour (cold cache, unknown watermark) must be answered with a
full projection rather than an error. The epoch in `daemonEpoch.ts` already
tells the client when to expect this.

### Phase 1 pass bar

Measured against the baseline, on the same bench:

- `list_workspaces` at ten workspaces: **under 50ms** median (from 2262ms), and
  git spawns per request **zero** on a warm cache.
- Git subprocesses over a 60-second ten-workspace streaming window: **down at
  least 20×**.
- `get_chat_projection` at 4000 rows: **under 100ms** (from 4829ms), and the
  curve flat enough that 4000 rows costs under 2× what 500 does.
- Daemon CPU seconds over that same streaming window: **down at least 5×**.

Phase 2 is justified only if, after Phase 1, the residual polling still shows
up as measurable daemon CPU in that window. If Phase 1 clears the bar and the
machine is quiet, Phase 2 is optional and should be re-argued on its merits
rather than inherited from this document.

## Phase 2 — stop polling

With the caches in place the daemon can diff a thread's projection across
updates and broadcast the changed items, and publish workspace summary rows
the same way. The renderer applies deltas by id into the existing keyed stores
and drops its polling loop.

What Phase 2 must settle, deliberately left open until Phase 1's numbers
exist:

- Delta event shape, and how it coalesces daemon-side (one tick per thread,
  accumulating changed items) so the push does not simply move the flood from
  pulls to events.
- Resync: on connect, daemon replacement, or a gap, the client must be able to
  ask for a full projection and continue. The epoch machinery in
  `daemonEpoch.ts` is the hook.
- CLI behaviour: it is a one-shot reader, so it should keep using the pull
  path. New events must be ignorable by an older client, as the existing
  `#[serde(default)]` conventions in the event enum already allow.

## Verification

Written tests plus a load bench, then both surfaces by hand.

**Bench** (built first, to get a baseline before any change): seed
`provider_events` directly and drive load with replay-provider fake binaries
rather than real logged-in agents, so runs are reproducible and cost no quota.
Both recipes are established in this project. Across roughly ten concurrent
workspaces, measure:

- daemon CPU time over a fixed streaming window
- git subprocess spawn count over that window
- per-RPC latency and response bytes, swept against transcript length — the
  slope is the finding, not any single number
- renderer CPU in the real Electron binary, not headless Chromium, which
  misreports compositing cost

**Tests**: projection cache output equals the from-scratch projection for the
same records, including out-of-order arrival and a late record that mutates an
earlier item; cursor pulls plus a full pull converge on the same timeline;
git-fact cache invalidates on each triggering event and refreshes on the
interval; the renderer's inventory coalescer collapses a burst to one trailing
run.

**By hand**: CLI chat read, desktop chat, and the iOS client all still render a
streaming turn correctly, with several workspaces running at once, including
switching into a chat that streamed while it was off screen — which is the
behaviour this whole change exists to keep affordable.

## Left to the builder

- Projection cache eviction policy and retained-thread cap.
- Whether the per-thread recompute is narrowed further than "recompute from
  retained records", given the equality test.
- Git-fact refresh interval and the exact event list that invalidates an
  entry — both informed by the bench.
- How image bytes are addressed once they leave the projection payload.
- Coalescing intervals, and the internal shape of the daemon caches.
