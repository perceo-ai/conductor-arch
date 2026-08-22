# Conductor Parity Assessment — 2026-08-20

Measured against Conductor's public changelog through 0.82.0 (Aug 20, 2026),
and against what this repository actually implements (verified by grep and by a
full GUI+CLI dev-loop run, not by reading old docs).

## Verdict

Archductor is at parity on the **single-user local loop** — the thing Conductor
shipped between 0.1 and roughly 0.65. It is behind on everything Conductor
added after it turned into a **team/cloud product**: hosted sandboxes,
multiplayer, stacks, and mobile.

The gap is not a long tail of small features. It is three product bets
Archductor has not taken.

## At parity

These exist here and match the Conductor capability:

| Capability | Conductor | Archductor |
|---|---|---|
| Worktree-per-task workspaces | 0.2.0 | `workspace.rs`, worktree + branch |
| Multiple chats per workspace | 0.17.0 | chat threads, tabbed |
| Diff viewer + file explorer | 0.16.0 | Changes/Files panels, scoped diffs |
| Code review comments | 0.10.0 / 0.22.0 | `review` verbs, file-scoped comments |
| Checkpoints | 0.19.0 | create/compare/restore/delete |
| Plan mode / fast mode / effort | 0.21, 0.40, 0.48.5 | per-session controls |
| Queue + steering | 0.54, 0.50 | queued inputs, `--immediate` |
| Command palette | 0.14.0 | `CommandPalette.tsx` |
| Checks tab, PR checks | 0.31.1, 0.29.4 | checks panel, `pr-readiness` |
| Linear + GitHub issue/PR sources | 0.15, 0.32, 0.66 | New workspace sources |
| Run/setup scripts, hooks | 0.9.0 | script + hook surfaces |
| Repo config file | 0.11.0 `conductor.json` | `.archductor/settings.toml` |
| Todos, tasks | 0.28.4, 0.33.0 | todos + first-class task model |
| Chat summaries | 0.22.6, 0.34.2 | summaries + refresh/briefing |
| Multi-provider agents | 0.18, 0.63, 0.69 | codex, claude, opencode, cursor, ACP |
| Custom/alt providers | 0.13.6 | provider registry + ACP adapter |
| Terminal in workspace | 0.10.2, 0.48 | terminal dock |
| Background tasks | 0.77.0 | `background_tasks.rs`, multi-agent |
| MCP server exposing the app | 0.82.0 | `archductor mcp serve`, 24 tools |

Two worth calling out: **background tasks** and **an MCP server that exposes
the product to agents** both exist here, and Conductor shipped its MCP server
only in 0.82.0 (this week). On those, Archductor is level or slightly ahead.

## Missing — the three bets

**1. Hosted execution (0.78 Cloud, 0.79, 0.81).** Conductor runs workspaces in
isolated microVMs with repos and dependencies pre-installed, so agents keep
working when the app is closed. Archductor's answer is a *self-hosted* remote
daemon: `archcar` binds a token-guarded TCP listener and any client points at
it. As of today a machine can hold many saved daemons and switch between them
from the sidebar. That covers "run somewhere else"; it does not cover managed
sandboxes, provisioning, dependency pre-install, or persistence independent of
any machine you own. Different bet, roughly a quarter of the value.

**2. Multiplayer (0.77).** Seeing teammates in a workspace, prompting together,
sharing workspace links. Archductor is single-user throughout — no identity, no
presence, no sharing primitive. Nothing in the codebase moves toward it.

**3. Stacks (0.80).** Stacked PRs with in-workspace switching and a
stack-ready-to-merge signal. Verified absent — no Graphite or `gh stack`
handling anywhere.

## Missing — smaller, cheap

Each verified absent by grep:

- **Chat/workspace search** (0.26, 0.31). No search over threads or workspaces.
- **Workspace + chat deep links** (0.71). No URL scheme.
- **Pinned workspaces** (0.25.3), **unread marking** (0.25.11), **workspace
  grouping** (0.35.2). Sidebar has none of these.
- **Notes tab** (0.27.0).
- **GitHub Actions integration** (0.33.2). Checks exist, but not workflow runs.
  (**Vercel deployments** (0.29.2) is a deliberate non-goal.)
- **Mobile app** — Conductor's is upcoming; Archductor has no client story
  beyond desktop + CLI.

## Missing — and already on the roadmap

- **Multiple git repos per project** (Conductor 0.25.6, Dec 2025). Archductor
  explicitly rejected this: "the product model stays one repository per
  project". This is the second of the three bullets that opened this workstream
  and is still unbuilt.
- **Skill/agent-config sync** (Conductor 0.43 Skills, 0.57 "sync agent
  configurations"). Archductor parses skill cards in the transcript but has no
  library, no install, no sync to Claude/Codex/other clients. This is the first
  of the three bullets, also unbuilt.

## Where Archductor is genuinely differentiated

- **Self-hosted remote by default.** Conductor's remote story is their cloud;
  Archductor's runs on hardware you own, with the CLI, MCP, and desktop all
  following one selection.
- **CLI as a first-class surface.** 97 `archcar` verbs against the same daemon
  the GUI uses. Conductor is GUI-first with an alpha API.
- **A protocol, not an app.** `docs/api.md` treats archcar RPC + MCP as the
  external contract, which is why a headless Linux daemon driven from macOS
  works today.

## Agreed order (2026-08-20)

1. **GitHub Actions** — workflow runs beside the existing checks surface.
2. **Skill/MCP library** — `/skill` discovery in the composer, one-click sync
   across on-device providers, and a catalog of installable skills.
3. **Multi-repo projects** — structural, so the longer it waits the more it
   costs.
4. **Small polish batch** — search, deep links, pinning, unread, grouping,
   notes.

Not scheduled: **Vercel** (dropped), **Stacks** (only if the team adopts
stacked PRs), **multiplayer / hosted sandboxes** (company-shaped bets that need
an explicit product decision, not a ticket).
