# Baseline: what concurrency costs today (2026-11-19)

Release binaries (`make build-release`), macOS (darwin 27.2), scratch daemon,
one-commit seed repository. Reproduce with `scripts/perf/inventory-cost.mjs`
and `scripts/perf/chat-rpc-slope.mjs`.

Figures are the **minimum of 15 samples**, with a `noise` column (max/min)
beside them. The minimum is the right estimator here: the measuring machine is
usually running the very concurrent-agent load under study, and that noise is
additive, so the floor is the closest thing to inherent cost. A noise ratio
above 2 means the figure should not be quoted.

## Read this before quoting an earlier draft

The first version of this document was wrong in both directions, and the
corrections are the reason the numbers below can be trusted:

1. **The chat figures were ~26x too high.** The replay provider was never
   actually invoked. The provider executable override is read from the
   **repository root**, not the worktree — `build_session_launch` calls
   `repository_settings(&repository.root_path)`
   (`crates/core/src/workspace.rs:6881`) — so the daemon launched the real
   `claude`, which cannot log in under a scratch `HOME`. The "transcript" being
   measured was nine rows: a `session_error`, a failed `turn`, and some
   lifecycle and hook records, multiplied in SQL. Measuring a real 209-row
   replayed transcript instead moved one refresh tick at 4000 rows from 4861ms
   to **186ms**.
2. **A claimed superlinearity ("40x rows → 155x time") did not survive.** It
   came from a single debug-build run, at median-of-5, on a loaded machine,
   over that same invalid row mix. Withdrawn — see the slope section.
3. **Debug binaries were used throughout.** They exaggerate the chat path
   substantially. They make almost no difference to the inventory path, which
   is itself a finding: that cost is not in our code.

## Inventory refresh (`list_workspaces`) — the dominant cost

Six git subprocesses per active workspace, every call, nothing cached. Timing
measured without the counting shim (which adds an exec per spawn); spawn counts
measured with it, and they are exact and deterministic.

| active workspaces | min | median | noise | git spawns | per workspace |
|---|---|---|---|---|---|
| 1 | 321ms | 551ms | 2.3 | 6 | 321ms |
| 2 | 902ms | 1011ms | 1.6 | 12 | 451ms |
| 5 | 2240ms | 2697ms | 1.5 | 30 | 448ms |
| 8 | 3583ms | 4364ms | 1.5 | 48 | 448ms |
| 10 | **5019ms** | 5865ms | 1.5 | **60** | 502ms |

`get_inventory_snapshot` — what the desktop calls on startup and on every
window focus — at 10 workspaces: **5136ms**, 61 git spawns.

Flatly linear at roughly **450ms and 6 git subprocesses per active
workspace**. The calls are:

- `git rev-parse --abbrev-ref --symbolic-full-name @{u}` — `workspace.rs:6308`
- `git rev-list @{u}..HEAD` and `git rev-list HEAD..@{u}` — same function
- `git merge-base` + `git diff --shortstat` — `workspace.rs:4675`
- `git status --short` — `workspace.rs:4071`

The desktop fires `list_workspaces` **uncoalesced** from six separate archcar
events (`turn_completed`, `session_started`, `session_exited`,
`chat_queue_updated`, `background_task_updated`, `task_updated`), so a busy
minute across ten workspaces keeps the daemon permanently spawning git. This is
on a repository with one commit and an empty worktree; `git status` cost grows
with tree size, so a real checkout is worse.

## Chat refresh, against transcript length

Rows are real `provider_events`: a replay-provider fake streamed a recorded
capture (`subagents_and_background_tasks.jsonl`) through the daemon's real
ingest path, producing 209 genuine rows, which were then multiplied in SQL with
fresh identities so items do not merge. The four RPCs are the ones the renderer
fires per refresh tick.

| rows | get_chat_projection | noise | get_chat_snapshot | one tick | bytes |
|---|---|---|---|---|---|
| 223 | 3.9ms | 16.4 | 2.6ms | 8.0ms | 38kB |
| 506 | 8.0ms | 10.2 | 3.7ms | 12.9ms | 86kB |
| 1003 | 12.7ms | 15.6 | 2.7ms | 16.9ms | 174kB |
| 2004 | 27.9ms | 12.7 | 2.9ms | 31.9ms | 353kB |
| 4006 | 181.2ms | 3.0 | 2.8ms | 186.5ms | 717kB |

**`get_chat_projection` is the entire chat-side cost.** Everything else is flat
and small. `get_chat_snapshot` with `include_provider_events: false` is ~1kB
and does not grow with transcript length, so the snapshot is not a target.

**The slope is linear up to ~2000 rows, with an unexplained jump after.** 223 →
2004 rows is 9x the rows for 7.2x the time — linear, about 14µs per row. But
2004 → 4006 is 2x the rows for 6.5x the time. Bytes stay linear throughout
(~0.175kB/row), so the jump is CPU, not serialization. It is one data point,
taken at the sweep's end where allocation pressure is highest; it is not enough
to call the function quadratic, and the earlier claim that it was has been
withdrawn. Treat the projection as linear with a possible threshold effect, and
do not spend engineering on the candidate quadratics
(`background_agent_folds.iter().any(...)` at `provider_projection.rs:370`, or
the body clone-and-append on merge) until the jump reproduces on an idle
machine.

## What this means for priorities

The two hogs are not close. One `list_workspaces` at ten workspaces costs
**5019ms and 60 git subprocesses**; one chat refresh tick on a long 4000-row
thread costs **186ms and no subprocesses**, and a more typical 1000-row thread
costs 17ms. The inventory path is roughly 27x the chat path at the sizes that
actually occur, and it is the one fired uncoalesced from six event types.

So the cheap desktop-side change — coalescing inventory refreshes and not
firing them for streamed tokens at all — is worth more than everything else in
Phase 1 combined, and it needs no protocol change. The projection cache remains
worth building, because 10 ticks a second per thread across many threads still
adds up and the cost grows with chat length, but it is the second priority, not
the first.
