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

# After Phase 1 (2026-11-19)

Same harness, same machine, release binaries, minimum of fifteen samples.

## Inventory refresh (`list_workspaces`)

| active workspaces | before | after | git spawns before | after |
|---|---|---|---|---|
| 1 | 321ms | 6.3ms | 6 | 0 |
| 5 | 2240ms | 5.4ms | 30 | 0 |
| 10 | 5019ms | **2.2ms** | 60 | **0** |

`get_inventory_snapshot` at ten workspaces: 5136ms and 61 git subprocesses
before, **41.9ms and 1** after. The response is byte-identical to the previous
inline-git version (3906 bytes at ten workspaces, 4222 for the snapshot) — an
earlier attempt collapsed `branch_push_state` to `None` when a workspace had no
upstream, which silently turned `branch_ahead: 0` into an absent field and
showed up as a 350-byte drop.

The remaining single git spawn on the snapshot path is the first, cold
derivation for a workspace nothing has measured yet.

## Chat refresh, against transcript length

`get_chat_projection`, cold (cache miss) and warm (cache hit), after both the
projection cache and the quadratic fix:

| rows | before (no cache) | cold | warm | bytes |
|---|---|---|---|---|
| 221 | 3.9ms | 18.7ms | 3.1ms | 37kB |
| 504 | 8.0ms | 89.1ms | 4.5ms | 84kB |
| 1006 | 12.7ms | 266.1ms | 9.6ms | 170kB |
| 2008 | 27.9ms | 285.7ms | 25.2ms | 345kB |
| 4008 | 181.2ms | 620.9ms | **65.7ms** | 701kB |

Two honest caveats on this table.

**The cold column is worse than the "before" column**, and that is expected
rather than a regression: a cold pull now also pays to parse and retain the
records, and in this benchmark every size is a thread the daemon has never
projected. In production a thread goes cold only on daemon start or eviction,
and the warm column is what a streaming turn actually pays.

**The cache was not where most of the win came from.** It moved 4000 rows from
181ms to 133ms — the SQLite read and the JSON parse were not the dominant cost.
That isolated the rest as CPU inside the projection and made the suspected
quadratic provable: `render_provider_event_projection` scanned its accumulated
background-card folds linearly for every event. Replacing that scan with a set
took the same pull from 133ms to 65.7ms. So the earlier withdrawal of the
superlinearity claim was itself wrong — the claim was right, the evidence for
it was not, and removing the I/O is what made it measurable.

The projection is still mildly superlinear (4000 rows costs about 15x what 500
does, where linear would be 8x), so the plan's flatness bar was not met. The
absolute figures are now low enough that this is a follow-up rather than a
blocker.

## What is still unmeasured

The projection delta cursor was not built, so a streaming 4000-row thread still
ships about 700kB per pull — roughly 2.7MB/s at four pulls a second, per
thread. That is the clearest remaining cost and the reason to do the cursor
work, but it is a protocol change across the daemon, the desktop and iOS and
belongs in its own change.

## After the review fix pass

The fixes that closed the staleness holes also touched the hot paths, so
everything was re-measured on release binaries.

`list_workspaces` at ten workspaces: **1.9ms, 0 git subprocesses, 3906 bytes** —
unchanged from before the fixes and byte-identical to the original.

The clearest number is the daemon's own steady-state cost. Ten workspaces, no
sessions running, nothing asking it anything:

| | idle daemon, 10 workspaces |
|---|---|
| git subprocesses | 3.6/s |
| daemon CPU | 0% of one core (0.16s over 40s) |

That 3.6/s is exactly what the staleness ceiling implies — ten workspaces, six
subprocesses each, re-derived no more often than every fifteen seconds — so the
background cost is now a small constant rather than a per-request charge of
sixty subprocesses.

The ten-workspace streaming window reports 59 git subprocesses a second against
121 at base, but that figure counts the benchmark's own `session send`
invocations, because the counting shim sits on `PATH` for the CLI as well as
the daemon. It is a fair before/after on the same harness and a poor absolute
number; the idle measurement above is the one to quote for the daemon.

## Verified in the real application

Benchmarks prove the socket, not the window. Both surfaces were driven for
real against a scratch daemon with a replay-provider agent:

- **CLI** — `archductor chat <ws> --full` renders a streamed turn: nested
  subagent cards, tool calls with results, the background task. Two consecutive
  projection pulls are identical; a pull from a *freshly started* daemon with an
  empty cache is identical to the cached one; and a second streamed turn grows
  the timeline from 16 items to 30, so records fold into the cache end to end.
- **Electron** — the real window opens past the setup gate, the sidebar shows
  the cached git facts as a live badge (`Alpha +1 −0`, file counts on each
  workspace), and the chat surface renders the full nested timeline with the
  Changes panel agreeing at `notes.txt +1 −0`.

# The attention sweep, on the same cache (2026-11-21)

`#272`'s `list_attention` built its workspace rows through
`agent_status::collect_status`, which used `WorkspaceStore::list_status()` —
the variant that derives each active workspace's git facts inline. That is the
same cost removed from `list_workspaces` above, paid again on every miss of the
sweep's own three-second cache.

Measured with `scripts/perf/inventory-cost.mjs` (which now includes
`list_attention`) and a probe that waits past the three-second TTL before each
sweep, so every one is a genuine miss rather than a hit on the attention cache.
Ten workspaces, release binaries, one-commit repository:

| cold `list_attention` | before | after |
|---|---|---|
| git subprocesses per sweep | 50, 68, 50, 71 | 0, 0, 0, 1 |
| time per sweep | 3026ms | **2.3ms** |

The response is 135 bytes on both sides — the queue itself is unchanged; only
what it costs to build is.

`#272` measured this path at 10–14s with thirty workspaces and mitigated it
with the TTL. The sweep now reads the same derived set the inventory does, so
there is nothing left for the TTL to hide.

**Watch the TTL when measuring this.** Nine rapid samples report zero git
spawns on the *unchanged* code too, because the attention cache serves them.
The first version of this measurement did exactly that and would have claimed
the win without the change being present.
