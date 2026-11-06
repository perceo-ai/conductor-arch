# qa validation evidence — PR #248

Captured by `qa` while reviewing
[PR #248](https://github.com/perceo-ai/conductor-arch/pull/248) at head
`43b670da8baaf385535a312464399d69c115a0f3`.

This branch holds **only** review evidence. It is deliberately **not** the PR
branch: pushing these files onto `fix/usage-greptile-t-cbef7baf` would move the
head sha and reset the CI and Greptile re-review clock that had already settled
on `43b670da`.

## How the screenshots were produced

PR #244's Usage pane is Electron, and the review box has no display or `xvfb`,
which is why the implementer reported the P1 as visually unverifiable. Instead
of the packaged app, the **real `ProviderUsageCard` component** was mounted in a
browser through a one-file Vite harness that swaps only `@/bridge/client` for a
stub, keeping the app's own stylesheets. Each state was then captured twice:

- **BEFORE** — a worktree at `192a24ab6` (PR #244's merge commit on `main`),
  i.e. what users have today.
- **AFTER** — PR #248 head `43b670da`.

The harness itself is review scaffolding and is not part of the PR.

## Panels

| Finding | Panel |
| --- | --- |
| 1 (P1) daemon disconnected | `panels/panel-c1-p1-daemon-disconnected.png` |
| 1 (P1) older daemon refuses the request | `panels/panel-c1-p1-daemon-refuses.png` |
| 1 (P1) failed refresh keeps the last good bars | `panels/panel-c1-p1-refresh-keeps-bars.png` |
| 4 (P2) 95% used still has room | `panels/panel-c4-headline-95pct.png` |
| 4 (P2) 100% used is out of room (no regression) | `panels/panel-c4-headline-100pct.png` |
| 2 and 3 (P2) API-key auth, bounded Keychain probe | `panels/panel-c23-apikey-and-keychain-error.png` |

`pr248-before-after.mp4` stitches the six panels at 3 seconds each.
