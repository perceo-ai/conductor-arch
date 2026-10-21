# qa review round 2 — PR #183 (task t_9bae4e9f)

**Verdict: APPROVED.** All 6 acceptance criteria test-proven, 0 visually
verified (see "Needs a human"). My round-1 blocking finding is fixed, and I
proved each half of the fix load-bearing with its own executed RED on the
project's own macOS runners rather than taking the dev's green CI on trust.

Head reviewed: `103960e5fafc1eafaf2c847176e95a4c3fbc55d2` — OPEN / MERGEABLE /
`mergeStateStatus: BEHIND`. CI on that sha: `total=22 notcompleted=0
nonsuccess=0`, re-read immediately before posting. Lens for this round:
execution.

**BEHIND is not a finding** — main moved to `4dbe1175` (PR #181) after the PR's
CI run, and that commit touches no `ios/` path. Because the tree that ships is
neither base nor head, I re-ran every tree-wide grep below on `git merge
4dbe1175 <- 103960e5` (`merge_exit=0`, sentinel `checksError` present), not on
the branch. Updating the branch would move `headRefOid` and re-trigger CI plus a
Greptile re-review, so the merger should expect that if they choose to.

**Greptile has settled on the final sha and withdrawn its finding.** Its check
on `103960e5` ran `08:40:44Z → 08:48:15Z`, after the final push at `08:40:35Z`;
its summary comment was re-edited `08:48:17Z` and now reads *"the previous
finding is fixed and no new actionable issues were found"*, confidence 5/5,
footer `Reviews (2) · Last reviewed commit: 103960e5`. The P2 thread is
`isOutdated: true` (`isResolved: false` only because nobody clicked resolve).
I did not rest on that: M1 below is my own executed proof that the remedy works.

---

## 1. My round-1 findings, re-verified

| # | Round-1 finding | Status on `103960e5` | Evidence |
|---|---|---|---|
| F1 | **BLOCKING, AC3.** `ChecksPanel` renders `Could not refresh the latest data` with `lastError=nil` because `fetchChecks()`'s second leg succeeds and `request()` nils the cause | **FIXED** | `checksError` (ReviewStore.swift:27, captured at :123/:129, assigned at :131, cleared only when both legs succeed); `ChecksPanel` reads it (ReviewViews.swift:227). Proven load-bearing by **M1**. |
| F1b | **Unlisted sibling.** `TodosPanel` (ReviewViews.swift:351) reads `lastError` with the same exposure via `observe()`, which refetches changes and checks but never todos | **FIXED** | `todosError` (ReviewStore.swift:32, set at :139, cleared at :142); `TodosPanel` reads it (ReviewViews.swift:351). Proven load-bearing by **M2**. |
| F1c | **Weak assertion.** `aPartialRefreshKeepsReviewStale`'s `!= StaleBannerCopy.disconnected` passed on the generic no-cause wording, which is why green CI missed AC3 | **FIXED** | ReviewStoreTests.swift:155-159 now assert `lastError == nil`, that `checksError` carries `gh is not authenticated`, and that the banner text contains it and differs from the no-cause text. M1 fails on exactly those three lines. |
| F2 | **NON-BLOCKING.** Causes reach the banner as raw `String(describing:)` enum dumps | **Correctly left alone** | Carved out as **t_817a8262**, which is `ready` and carries the full spec. I re-diffed `ChatView.swift` / `ReviewViews.swift` over `e7bc715..103960e5`: no change to the three pre-existing verbatim renderers. Out of scope here, as asked. |
| — | Second qa pass's opportunistic note: `isDisconnected` assertions in the other three stores' failure tests | **Landed** | `103960e5` adds them to ChatStoreTests (×2), TerminalStoreTests, WorkspacesStoreTests (×2). No new test names, which the set-diff confirms. |

---

## 2. Criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Connected + one panel's fetch failing ⇒ that banner does not claim disconnected | **PASS** | `aPartialRefreshKeepsReviewStale` :151-152 and `aTodosFailureKeepsItsCauseThroughAnEventDrivenRefresh` :186/:190, plus 2 of 3 `StaleBannerCopyTests`. Both store-level tests survived both mutations at those lines, so the flag plumbing is independently sound. |
| 2 | Genuinely disconnected ⇒ banner still says so | **PASS** | `StaleBannerCopy.disconnected` is byte-identical to base's default (`cat -A` diff of both lines). `aDroppedStreamMarksReviewStaleAndRefetchesOnReconnect` :81-82 asserts `isDisconnected == true` and `text == disconnected`. `StaleBannerCopy.text` returns early on `isDisconnected` whatever the cause, pinned by `aRealDisconnectStillSaysNotConnectedWhateverTheCause`. |
| 3 | The cause held by the store is shown or summarised, **not dropped** | **PASS** (was the round-1 FAIL) | M1 and M2 below. Also checked **store-wide**, which the round-1 verdict did not: the other three stores have no equivalent exposure. `ChatStore.request()` does **not** nil `composerError` on success (ChatStore.swift:491-499), and every path that marks it stale with `isDisconnected == false` sets the cause in the same breath. `TerminalStore.refreshScreen()` and `WorkspacesStore.refresh()` each issue one request with the clear and the mark on the same path. So AC3 now holds for all four stores, not just ReviewStore. |
| 4 | One shared `StaleBanner`, all call sites updated, no per-screen copy | **PASS** | On the **merged** tree: one `struct StaleBanner` (DesignSystem.swift:259), one `enum StaleBannerCopy`, exactly 6 call sites all passing `isDisconnected` + `cause`. `grep "StaleBanner()"`, `grep "StaleBanner(text:"`, `grep "markStale()"` → all empty. Compile-verified, not just code-read: the `Build Archductor app target` step compiled **28/28** app-target files (`comm -23 tree compiled` empty), including all 5 changed View files; `StaleBannerCopy.swift` compiled in `Build ArchcarKit`. All 12 job steps `success`. |
| 5 | A test per AC1-2 asserting the rendered text, failing before and passing after; both CI logs | **PASS**, by my reconstruction — see §3 | |
| 6 | No existing test deleted, weakened or renamed; set-diff + counts | **PASS**, re-derived from four job logs | §4 |

---

## 3. AC5: the RED is mine, and this round it is two of them

There is still no tests-only commit on this branch, so no RED exists on CI for
the dev to cite — and the PR body says so plainly now, correctly describing the
merge-base run as a baseline rather than a "before". That is the right call and
I am not marking it down. But a baseline is not a RED, so I produced them, on
the project's own macOS runners via `workflow_dispatch`.

Each probe reverts **one** of my two round-1 remedies **alone** on the current
head, keeping every other fix in place, so one executed RED maps to one finding.

**M1 — `qa-probe/pr183r2-checks` @ `3b0b1d9`**, one line at ReviewStore.swift:131:

```diff
-        checksError = failure
+        checksError = lastError   // qa mutation M1
```

Run **39573601864**, job **119133642329**. Step 6 `Build ArchcarKit` **success**,
step 7 `Test ArchcarKit` **failure**, **zero** compiler `error:` lines ⇒
assertion-level RED, not compile-level. `Test run with 220 tests failed` —
**219 passed, exactly 1 failed**:

```
✘ aPartialRefreshKeepsReviewStale()
  :156  (store.checksError?.contains("gh is not authenticated") → nil) == true
  :158  (checksBanner → "Could not refresh the latest data").contains("gh is not authenticated")
  :159  (checksBanner → "Could not refresh the latest data") != (… cause: nil → "Could not refresh the latest data")
```

Surgical, and the passing lines are the informative half: :151 `isDisconnected
== false`, :152 `text != disconnected` and :155 `lastError == nil` all **passed**
under the mutation. So the probe independently re-confirms the mechanism I
described in round 1 — the cause really is wiped by the second leg — while
isolating the failure to the cause-bearing assertions.

**M2 — `qa-probe/pr183r2-todos` @ `bb93c6c`**, one line added to
`ReviewStore.request()`'s success branch (`todosError = nil`), which reinstates
"the todos cause does not survive another request's success" — exactly what
`observe()`'s loop does.

Run **39573626152**, job **119133708309**. Same step pattern, zero compiler
errors, `Test run with 220 tests failed` — **219 passed, exactly 1 failed**:

```
✘ aTodosFailureKeepsItsCauseThroughAnEventDrivenRefresh()
  :187  (store.todosError?.contains("todo store unavailable") → nil) == true
  :189  (todosBanner → "Could not refresh the latest data").contains("todo store unavailable")
```

Lines :183 (changes and checks cleared), :184 (`todosStale` still set), :185
(`lastError == nil`) and :186 (`isDisconnected == false`) all **passed**, so the
test reproduces the state rather than dying in a fixture. Line :190
(`!contains("not connected")`) also passed *under the mutation* — which is
precisely why round 1's weaker assertion let the dropped cause through green CI,
and why F1c was worth asking for.

Both probe branches are deleted. The PR branch was never touched, so
`headRefOid` did not move and Greptile's pass on this sha stays valid. I also
deleted my round-1 probe branches `qa-probe/pr183-ac3` and
`qa-probe/pr183-mutation` now that the finding is resolved.

---

## 4. AC6: four reference points, not two

A round-2 "do not regress" claim needs the previously-reviewed head as well as
the merge base, so I read the summary line from four job logs — including the
**intermediate** commit, whose parent run shows `cancelled` (the next push
cancelled it) while its iOS job completed `success` on its own.

| label | commit | run / job | checked out | summary |
|---|---|---|---|---|
| merge base | `e7bc715` | 39567303112 / 119112628398 | `e7bc715` | 216 passed |
| round-1 head | `11b90cbc` | 39567641649 / 119114009085 | `6db38bb` (pr/merge) | 219 passed |
| round-2 fix | `16d35c7a` | 39570742983 / 119124070442 | `3f12276` (pr/merge) | 220 passed |
| final head | `103960e5` | 39571089867 / 119125416772 | `bdc4f3c` (pr/merge) | 220 passed |

By **name**, not by total:

- `comm -23` merge-base → final head: **empty** (all 216 base names present verbatim)
- `comm -13` merge-base → final head: exactly 4 — the 3 `StaleBannerCopyTests` and `aTodosFailureKeepsItsCauseThroughAnEventDrivenRefresh`
- `comm -23` round-1 head → final head: **empty**; `comm -13`: exactly 1 (the todos test)
- `comm -23` / `comm -13` intermediate → final head: **both empty**, confirming the last commit added only assertions to existing tests

Deltas: **+4 vs the merge base, +1 vs the previously-reviewed head**. The PR
body's figures (216 → 219 → 220) match what I derived; I did not carry them over.

The PR run builds `refs/pull/183/merge`, whose parents are `(c810b589, 103960e5)`
— so the suite and the app-target compile ran against a real merge tree, which
is stronger than "green on the branch". `c810b589` was main at run time; main is
now `4dbe1175`, hence BEHIND, hence my own greps on the current merged tree.

---

## 5. Non-blocking notes — no change wanted on this PR

**N1 — two uncovered branches in the new code.** `reviewResponder` has
`checksFail`, `changesFail` and `todosFail` but no `runsFail`, so the
second-leg failure path (`failure = failure ?? lastError ?? …`,
ReviewStore.swift:129) is never exercised; and nothing asserts that
`checksError` is *cleared* after a successful checks refetch. Both are symmetric
with code that is tested and the exposure is bounded — the banner only renders
while `checksStale`, which is gated on the same success — so this is a note, not
a round. Worth a line if the file is touched again.

**N2 — `"The daemon did not answer."` is reachable when the daemon *did*
answer.** `request()` returns non-nil for any successful RPC, so a response of
an unexpected type falls into the `else` with `lastError == nil` and the user
gets "did not answer" for "answered something else". Not this diff's doing: the
literal is copied verbatim from `fetchChanges()`, which carries it on base
(ReviewStore.swift:91 at `e7bc715`). The dev mirrored the established pattern,
as the card asked. `WorkspacesStore` words the same case better
("unexpected response: …").

**N3 — the all-or-nothing `refreshAll()` clear can show a generic banner on a
panel that refetched fine.** If changes succeeds and todos fails, `refreshAll()`
clears nothing, so the Changes panel renders `Could not refresh the latest data`
with `changesError == nil`. That is #171's clearing design, unchanged here
(`StaleClearing.swift` is untouched), and the wording is honest if unhelpful.
Pre-existing; out of scope.

**N4 — `reviewDecision` is empty and `mergeStateStatus` is BEHIND.** I cannot
clear the first: the bot fleet shares one GitHub identity, so
`gh pr review --approve` on this PR fails as "cannot approve your own pull
request". That is an environment constraint, not a finding against the diff — a
human approving review is still needed before merge.

---

## Needs a human — visually unverified, carried forward from round 1

**No criterion was confirmed on a rendered iOS surface, and that has not changed
this round.** This box is Linux with no Xcode, no simulator and no Swift
toolchain; the CI job builds the app target but runs no UI test, so nothing ever
drew the banner. AC1-AC4 are proven at the level of store state, the pure copy
function, and a compiled app target — which is where the card put them.

**@Pranav**, one on-device check is still worth having, now against the final
copy: with a connected session and `gh` unauthenticated, open Review → Checks
and confirm the banner reads `Could not refresh — <the gh failure>` rather than
"not connected" or the generic "Could not refresh the latest data"; then pull
Todos with the todo store failing and confirm the same for that panel. Note the
cause will currently render as a raw enum dump (`daemon("gh is not
authenticated")`) — that is t_817a8262's job, not this PR's.

---

## Artifacts

Attached to t_9bae4e9f: **240** `r2-mutation-probes-round2.txt` (distilled M1/M2
findings), **241** `r2-ac6-setdiff-round2.txt` (the four-point set-diff with
commands), **242** `r2-head-ios-103960e5.log.gz` (final head iOS job
119125416772), **243** `r2-mutation-M1-checks-ios.log.gz` (job 119133642329),
**244** `r2-mutation-M2-todos-ios.log.gz` (job 119133708309), **245**/**246**
`r2-ac-ci-22-green-103960e5*.png` (checks page on the final sha, 22 green),
**247** `r2-ac-greptile-settled-103960e5.png` (summary footer naming this sha).
Round 1's 217-225 still apply.

Raw copies live on branch `qa-evidence/pr-183-r2`, which is evidence only and
not for merge.

**Not merged — chief owns the merge.** @chief: CI is green on the final sha,
Greptile's re-review has settled and withdrawn its finding, all 6 criteria are
test-proven. The PR is BEHIND main (`4dbe1175`, no `ios/` paths) and
`reviewDecision` is empty because the shared bot identity cannot self-approve,
so a human approving review is the one thing still outstanding.
