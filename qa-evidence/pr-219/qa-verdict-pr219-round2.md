# qa review — PR #219 `remote transfer` (task t_72c3b081), round 2

**Verdict: approved.** All eight of my round-1 findings are closed, and I
proved each one by execution rather than by reading the diff. CI is 23/23
green on the final head sha, Greptile's re-review ran **on that sha** and
returned zero comments, and no review thread is unresolved.

- head sha reviewed: `01fba9e8542c8054e929ed6cb206cddea003bc28`
- base: `main` @ `7182259dca14d35720620dc342545252e8ad8f85` (unmoved during this
  review — re-read at verdict time), `mergeable: MERGEABLE`,
  `mergeStateStatus: CLEAN`
- CI run `40611226769`: 23/23 checks SUCCESS, incl. `archductor/ci-gate`

## The review clock — why the Greptile silence is a pass, not a lag

This is the check that let a P1 onto main in #160, so it is worth stating
explicitly. The final push landed at `2026-10-28T00:49:28Z`, and the newest
Greptile **comment** on the PR is `00:40:00Z` — *older* than the push. Taken
alone that reads as "not re-reviewed yet". It is not:

```
Greptile Review  check-run on 01fba9e:  started 00:49:37Z  completed 00:52:40Z  success
  output.summary: "15 files reviewed, 0 comments added."
Greptile summary issue comment 6455106731: updated_at 00:52:42Z, "Confidence Score: 5/5",
  "appears safe to merge"
```

The bot re-reviewed the final sha and had nothing to say, so it posted nothing
new and edited its summary comment in place. The absence of a comment newer
than the push is the *result*, not a missing re-review. Unresolved review
threads: **0 of 13**.

## Reachability — what I could and could not execute

- **Rust CLI: still not executable here.** `cargo` and `rustc` are absent on
  this box. The five CLI-side findings are proven by reading the tree at the
  head sha, by the premises underneath them read in `crates/core` (not taken
  from the PR body), and by the CI job log.
- **Desktop: fully executable here.** The desktop twin of every finding was
  driven through the real `actions.transferWorkspace`.
- **Desktop UI: executable this round, unlike round 1.** `vite` with the repo's
  own config dies on this box (`vite-plugin-electron` spawns an Electron binary
  pnpm never downloaded). Dropping *only* that plugin — same Solid pipeline,
  same `@` alias — serves the renderer, so I mounted the real
  `workspaceMenuItems("parser")` inside the real `ContextMenu` and
  screenshotted it. Criterion 7 is therefore **no longer visually unverified**.

## Round-1 findings: all eight closed, each proven by execution

My four round-1 desktop probes asserted the **defective** behaviour, so a pass
was the proof the defect existed. Carried forward to this head (updated only
for the new `fromDaemon` parameter) they now **all four fail**, and each fails
on its behavioural assertion rather than on setup:

| round-1 finding | the probe's failure on 01fba9e |
|---|---|
| (f) desktop adopted an **archived** target | throws `…is archived but still holds branch lc/parser…` (`actions.ts:838`) |
| (g) desktop retired the source with no chat on the target | throws `…has none of the conversation…` (`actions.ts:979`), source untouched |
| (c) second hop skipped the agent | no longer early-returns; it starts a session and then **waits for a real delivery row**, which the defect-probe's mock never produces — so it times out instead of "succeeding" |
| (h) source endpoint re-resolved per request | the final `archive_workspace` lands on the **pinned** source, so the probe's `other-unpinned:archive_workspace` never appears |

Nine new probes assert the **fixed** behaviour; all nine pass:

```
✓ f FIXED: an archived holder of the branch is refused, and the source is left alone
✓ g FIXED: an adopted target with real history but no chat is refused, source left alone
✓ b FIXED: an empty source chat gets a thread opened on the target, not a bail
✓ c FIXED: the second hop starts a session and sends the real ask, not the carried preamble
✓ h FIXED: the final archive goes to the pinned source even after a selection switch
✓ a FIXED: a target the daemon renamed on collision is found on retry by its pushed commit
✓ a FIXED: a workspace on the same branch in a DIFFERENT repository is not adopted
✓ a FIXED: a target on our branch at its OWN commit is refused, not duplicated
✓ e FIXED: an EMPTY QUEUE with no message row is not delivery, so the source is not archived
```

The last one is the one I most wanted to see: it queues the handover, answers
`list_queued_chat_inputs` with an **empty queue** and never produces a message
row, and asserts the transfer is **still waiting** 1.5 s later with
`archive_workspace` never sent. That is finding (e) inverted — an empty queue
no longer counts as delivery.

### The two CLI premises I read in the source rather than taking on trust

Both underpin the fix and neither is in the diff:

- `seed_imported_chat` writes carried rows with `FORKED_MESSAGE_SOURCE`
  (`crates/core/src/workspace.rs:867` = `"fork"`, written at `:7932`), so
  excluding that source is what distinguishes a carried preamble from a
  delivered one — the (c) fix.
- The session appends the user message row **after** the write succeeds
  (`crates/core/src/archcar/session.rs:2251`, source `"user_send"`), while
  `claim_next_queued_chat_input` is a `DELETE … RETURNING`
  (`workspace.rs:8266`) with a requeue path — the (e) fix. The core suite even
  pins the premise: `claim_next_queued_chat_input_removes_row_before_delivery`.

## Acceptance criteria

| # | criterion | result |
|---|---|---|
| 1 | live session aborts without `--force`; with `--force` killed **before** push | **PASS** — test-proven. `stop_source_sessions` (main.rs:6257) precedes `publish_source_branch` (:6274); `remote_transfer_refuses_a_live_source_session_without_force` and `remote_transfer_force_stops_the_source_before_pushing_then_resumes_on_the_target` both green on the final sha. Desktop twin asserts the same ordering. |
| 2 | target workspace at the pushed commit, same base ref, transcript present | **PASS** — the adoption path that broke this in round 1 now matches on repository + pushed commit and refuses everything else; `remote_transfer_does_not_adopt_a_same_named_workspace_from_another_repository` and my desktop twin both prove it. |
| 3 | fresh session spawned on target, last user message delivered | **PASS** — holds for the first hop, the second hop (`remote_transfer_resumes_a_chat_that_already_carries_an_earlier_hops_preamble` + my probe asserting the **real ask** is replayed, not the carried preamble) and the empty-chat case (`…gives_an_empty_source_chat_the_continuation_prompt`). "Delivered" is now the message row, not an empty queue. |
| 4 | source archived **only after** resume confirmed | **PASS** — all three round-1 leaks closed. `remote_transfer_leaves_the_source_alone_when_the_target_cannot_take_the_workspace` and `…does_not_confirm_delivery_when_the_targets_agent_never_takes_it` pin it in CI; my (e) and (g) probes pin the desktop. |
| 5 | re-run does not duplicate the target workspace | **PASS** — and this is the part that took six rounds. Identity is now the import's own provenance (repository + pushed commit), so a target the daemon renamed on collision is still found: `remote_transfer_retry_finds_a_target_the_daemon_had_renamed`, reproduced on the desktop twin with a `parser-v2`/`lc/parser-v2` target that matches on **neither** the requested name nor the requested branch. |
| 6 | A→B by saved-client label, no hard-coded local | **PASS, caveat now closed.** Round 1's caveat was that the same-daemon guard compared address strings. It now asks each end who it is via `GetRemoteAccess` (token path + token out of the serving daemon's own `AppPaths`), with an explicit, *announced* fallback to the address compare for a daemon too old to answer. `remote_transfer_refuses_the_same_daemon_reached_under_two_names`. |
| 7 | desktop offers transfer-to with a target picker; CLI parity | **PASS — and visually verified this round.** Screenshots below. With the app on `frankfurt`: `Copy to this machine` plus `Transfer to this machine… / office… / devbox…`, and `frankfurt` correctly absent. On this machine: no `Copy to…`, and `Transfer to frankfurt… / office… / devbox…`. Behavioural parity with the CLI is proven by the probes above. |
| 8 | docs cover the command and its failure modes | **PASS.** Both sentences I flagged as false in round 1 are now true: the same-daemon refusal is documented with its identity caveat, and the archived-holder case is a documented refusal rather than a claimed non-adoption. The four refusal messages appear verbatim. The one real parity gap (`--name` has no desktop equivalent) is stated in the docs rather than hidden. |

## No test was lost to get here

The head's `core-cli-archcar` lane against main's run at the merge base:

```
base (main 7182259): 1319 test names   head (01fba9e): 1332 test names
comm -23 base head  → EMPTY   (no pre-existing test renamed, dropped or skipped)
comm -13 base head  → exactly 13, all remote_transfer_*
```

All 13 are new in this PR (`crates/cli/tests/remote_transfer.rs` is a new file;
round 1 had 3 of them). They map one-to-one onto the findings — one test per
defect, each named for the behaviour rather than the bug. Local full desktop
suite on the head: **105 files, 902 tests, 0 failures**.

## Notes for chief — not requests, nothing to action on the dev

1. **The PR body's Validation block is stale.** It reports `9 passed` for the
   `remote_transfer` binary and `899 passed` for the desktop suite; CI on the
   final sha reports **13** and my local run **902**. It is a local run that
   predates the last four commits, i.e. it understates the work. Cosmetic, and
   not worth a round-7 push that would move the head sha and void the settled
   CI and Greptile state.
2. **Six rounds on one card is the card's signal, not the dev's.** Criteria 2–5
   describe the first hop only; the second hop, the retry-after-rename and the
   adopt-the-wrong-repo cases were never written down, and every one of my
   round-1 findings lived in that unspecified space. The implementation is
   sound; the specification was thin. Worth remembering when the next transfer
   -shaped card gets written.
3. I did **not** push evidence to the PR branch, deliberately: that moves
   `headRefOid`, re-runs all 23 jobs and voids Greptile's pass on the exact
   commit I am approving. Images are on `qa-evidence/pr-219` and attached to
   the kanban task instead.

## Evidence

| file | what it shows |
|---|---|
| `criterion7-picker-remote-source.png` | the real context menu, app on `frankfurt`: three transfer targets, source excluded |
| `criterion7-picker-local-source.png` | the same menu on this machine: `Copy to…` gone, three saved daemons offered |
| `qa-probe-run-r2.txt` | 4/4 defect probes fail on their assertions; 9/9 fixed-behaviour probes pass |
| `qa-probe-r2-fixed.test.ts`, `qa-probe-r2-defects.test.ts`, `qa-probe-r2-harness.ts` | the probes themselves (qa artefacts, not part of the PR) |
| `base-tests-missing-from-head.txt` | empty — the no-regression proof by name, not by count |
| `new-tests-on-head.txt` | the 13 new tests |
| `r2-rust.log`, `r2-desktop.log`, `base-rust.log` | the CI job logs the above was read from |
