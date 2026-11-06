# qa evidence — PR #243 (task t_d57483c8)

PR: https://github.com/perceo-ai/conductor-arch/pull/243
Reviewed head: 4491a79cb2bb761e3b8562d06b56426ea5057fa1
Base at review time: 8727e65e6ac9f64ba0b1163a319c84eb327e0cdb (== `main` tip, re-read at verdict time)
Merge ref refs/pull/243/merge = 8a3eaff1, parents = (8727e65e, 4491a79c)
  -> parent 1 IS current main, so the `pull_request` CI run compiled and ran
     exactly the tree a merge produces, not just the branch.

## Gates

- check-runs on 4491a79: total=23, notcompleted=0, nonsuccess=0 (API aggregate;
  GitHub's Checks tab badge agrees at 23). The dev's "23/23" is correct.
- mergeable=MERGEABLE, mergeStateStatus=CLEAN, state=OPEN, not BEHIND.
- Review clock. Final push 2026-11-06T04:50:59Z. Greptile Review check on that
  sha: started 04:51:08Z, completed 04:53:14Z, success. Greptile edits its
  summary in place, so the comment's created_at (04:45:58Z) is misleading; its
  updated_at is 04:53:17Z and its footer reads
  "Reviews (2) · Last reviewed commit: 4491a79c", Confidence 5/5. The
  re-review therefore SETTLED on the final sha and found nothing new.
- One review thread exists (the re-review P1 on desktop/src/store/achievements.ts),
  answered by the dev in 4491a79 and marked resolved.

## My own red/green (not taken from the PR body)

Everything below I executed on this box. Rust toolchain installed locally;
desktop is plain TS/Solid and runs here.

### Executed GREEN on head 4491a79

| Suite | Result |
|---|---|
| `cargo test -p archductor-core --lib` | 1260 passed, 0 failed, 2 ignored |
| `cargo test -p archductor-core --lib achievements::` | 16 passed |
| `cargo test -p archductor-core --lib storage::` | 2 passed |
| `cargo test -p archductor --bin archductor achievements` | 2 passed |
| desktop `pnpm run typecheck` | exit 0 |
| desktop `pnpm test` | 125 files, 1080 tests passed |

Every number matches the PR body's claim exactly.

### No-regression, by name and by binary

Base run = CI run 42161425162 on main 8727e65 (the #242 merge).

- Rust, per test-binary `test result:` vector:
  base  [0,58,39,1,3,1,15,1256,1,1,2,8,0,39]
  head  [0,58,39,1,3,1,15,1260,1,1,2,8,0,39]
  One binary moved, by exactly +4.
- Rust, by NAME over the test names the lane prints individually
  (883 base / 887 head): `base - head` is EMPTY, `head - base` is exactly
  a_secret_is_revealed_by_its_first_tier_and_not_before,
  custom_workspace_names_do_not_feed_cartographer,
  failed_processes_counts_exited_rows_with_a_failing_exit_code,
  upgrading_backfills_discoveries_so_they_outlive_the_workspace.
  (That set covers 918 of the lane's printed lines, not the whole 1424 the
  `test result:` lines sum to, so it is a subset proof over what the log names,
  plus the per-binary vector above for the rest.)
- Desktop: base 125 files / 1071 tests -> head 125 files / 1080 tests, +9, which
  is exactly the 9 new tests (4 store, 3 clients, 2 page), all of which I ran
  locally and watched pass (desktop-new-tests-verbose.txt).

### Executed RED on base product code

`git checkout base -- crates/core/{achievements,workspace,storage}.rs`, then
spliced ONLY the diff's new test functions (+ the `insert_process` helper) onto
that tree. Confirmed first that the fix markers (`is_revealed`, `exit_code <> 0`,
`backfill_workspace_name_discoveries`, `names.retain`) grep to 0 in the product
files and that `status = 'failed'` is still at achievements.rs:597.

    failed_processes_counts_exited_rows_with_a_failing_exit_code  left: 0, right: 2
    custom_workspace_names_do_not_feed_cartographer               left: 10, right: 0
    upgrading_backfills_discoveries_so_they_outlive_the_workspace assertion failed: discovered.contains(pool_name)

12 pre-existing tests in the same module still passed, so the splice compiled
and the fix is the only variable. All three failures land on the criterion's
own assertion, not in setup.

### Real-binary A/B on a byte-identical database (criteria 2, 3, 4, 5-CLI, 6)

Built the CLI at BOTH shas. Seeded one DB shaped like a v0.14.0 install
(1 pool-named workspace "arch", 10 custom-named, empty workspace_name_discoveries,
five exits with non-zero codes plus decoys: exit 0, exit NULL, a stopped/143,
a running row). Copied it so each binary saw identical bytes.

    - Copper    Cartographer                 11 next 40      <- BASE 8727e65
    + -         Cartographer                 1 next 10       <- HEAD 4491a79
    + [Debugging Chaos]
    + Copper    It Died Again                5 next 40
    - 4 secret achievement(s) still hidden
    + 3 secret achievement(s) still hidden

Reading that:
- criterion 3: base earns Cartographer Copper off 11 raw workspace names while
  `discovery 1/200`. Head reports 1, matching the discovery line. Confirms the
  PR body's "Cartographer can drop" warning is real and user-visible.
- criterion 2: "It Died Again" is a SECRET achievement (catalog line 486), so on
  base it is invisible AND permanently stuck at 0; on head it counts exactly the
  5 failing exits and ignores exit 0, a NULL exit code, a stopped/143 and a live
  row. The hidden-secret count moving 4 -> 3 is that same badge becoming earned,
  which is why the two halves of the diff reconcile.
- criterion 4: after the head binary opened the DB the backfill had recorded
  ('arch','1700000000'); deleting that workspace row left `discovery 1/200` and
  `[x] arch` intact.
- criterion 5 (CLI): `--locked` prints no secret names and reports only a count.
- criterion 6: `## Achievements` lands in docs/guides/cli.md (line 389), the
  guide indexed as "CLI cookbook" in docs/guides/README.md, which is what
  claude/CLAUDE.md requires when a CLI flag changes. `--names` behaviour in the
  guide matches the binary: `[x] arch`, no custom names listed.

Note: the 'running' row I seeded was reconciled to exited/NULL on first open by
the daemon's own startup path. Still not counted, which is correct.

### Live UI, real page + real store (criteria 1, 5-desktop, re-review P1)

Electron cannot be packaged on this box, but the renderer is plain Solid+Vite,
so I served the REAL `AchievementsPage`, the REAL `achievementsStore` and the
app's own stylesheets on a vite dev server with only `@/bridge/client` swapped
for a scripted two-daemon fake, and drove it in a browser. The switch helper
makes exactly the two calls `clients.ts::resync()` makes after bumping the
epoch (`achievementsStore.daemonChanged()`, then `load()` when the page is
showing) — the inventory pull failing is precisely why nothing navigates, which
is the whole mechanism of the re-review P1.

- c1-RED-on-base-previous-machine-badges-remain.png — base store, switch inside
  the 60s window: `daemon=laptop` but the page still shows devbox's 2/4, 1/200
  and "It Died Again". `achievementsStore.daemonChanged` is `undefined` there.
- c1-switch-inside-freshness-window-refetches.png — head: same switch, refetched,
  1/4, 17/200, Worktree Wrangler SILVER 41/100.
- p1-rereview-new-daemon-down-shows-error-not-old-badges.png — head, new daemon
  cannot answer: "Could not load achievements: laptop down", old badges gone,
  no scoreboard left behind.
- c5-RED-on-base-secret-revealed-at-3of10.png — base page: secret "Permission
  Denied Any%" rendered at 3/10 with no tier, hidden-count line gone.
- c5-desktop-secret-below-first-tier-hidden.png — head, same payload: card
  hidden, "1 secret achievement still hidden".
- pr243-achievements-ui-flow.mp4 — the five captioned in order.

Nothing was committed to the PR branch; the swaps were local and reverted.

## Notes for chief (not findings, no action required)

- `backfill_workspace_name_discoveries` re-reads the custom-named workspaces on
  every DB open, because custom names are filtered out before insert and so
  never satisfy the `NOT IN`. It is one indexed read over a tiny table before
  any write lock is taken, so this is a remark, not a cost.
- `workspace.rs:1710` still records every new workspace name, custom ones
  included, into `workspace_name_discoveries`; `discovered_workspace_names()`
  filters them on read. Consistent, but the table accumulates rows nothing reads.
- `desktop/src/bridge/protocol/responses.ts` is hand-maintained — there is no
  Rust/TS protocol parity test in the repo, so the new `revealed` field is kept
  in step by review only. No Swift consumer of achievements exists, so the iOS
  lane is unaffected.
