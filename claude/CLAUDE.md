# Claude Agent Instructions

## Read This First

Before touching code or docs in this repository, read:

1. `README.md`
2. `progress.md`
3. `docs/manual-testing-checklist.md`
4. `docs/conductor-docs-parity-map.md`
5. `docs/deploy-and-local-test.md`

Use official Conductor behavior as the parity baseline:

- `https://www.conductor.build/docs/concepts/workspaces-and-branches`
- `https://www.conductor.build/docs/concepts/workflow`
- `https://www.conductor.build/docs/concepts/parallel-agents`
- `https://www.conductor.build/docs/reference/settings`
- `https://www.conductor.build/docs/reference/scripts`
- `https://www.conductor.build/docs/reference/files-to-copy`
- `https://www.conductor.build/docs/reference/agent-modes`
- `https://www.conductor.build/docs/reference/diff-viewer`
- `https://www.conductor.build/docs/reference/checks`

## Product Baseline

Linux Conductor is a local desktop control plane for parallel coding agents.
The core loop should work in the app: add or clone a repository, create
workspaces, run multiple chats/sessions, review work, create/merge PRs, archive,
and repeat for the same repository.

Do not market scaffolding as a feature. Distinguish clearly between core, CLI,
GTK controls, and verified end-to-end app behavior.

## Operating Mode

- Move fast, but keep changes direct and obvious.
- Prefer working product increments over architecture theater.
- Do not invent broad abstractions unless they remove immediate complexity.
- Do not add backend-only commands unless they unblock the app workflow.
- Implement, verify, and keep going.
- Fix stale docs when you find them.
- Do not call a feature done without current evidence from code, tests, CLI
  smoke, or GUI/runtime verification.
- If auth, API keys, display server, network, local tools, or test data are
  missing, say exactly what was not verified.

## Current State

The app has a usable but rough Conductor loop:

- Projects can add/clone repositories, edit shared/local settings, and create
  branch/prompt/GitHub/Linear workspaces.
- Workspaces are real Git worktrees with `.context` files and stable port
  ranges.
- The workspace page can start Shell, Codex, Claude, and Cursor sessions,
  terminal shells, setup/run scripts, review tabs, checks, todos, and lifecycle
  actions.
- The Checks tab can create/refresh PRs, read checks/comments, stage context for
  agents, merge, and archive after merge when configured.

Known rough edges:

- Agent chat is PTY/transcript based, not a polished structured chat UI.
- Terminal rendering is not a full terminal emulator.
- Command palette, broad shortcuts, deep links, monorepo directory selection,
  linked directories, richer GitHub review-thread sync, and unified local
  history are incomplete.
- GitHub-backed flows require local `gh` auth.
- Linear-backed flows require `LINEAR_API_KEY`.

## Engineering Rules

- Work from this workspace unless explicitly told otherwise.
- Target branch is `origin/main`; do not rename the current branch.
- Check `git status --short` before edits and before final response.
- Do not revert user or other-agent changes unless explicitly asked.
- Use `rg`/`rg --files` for search.
- Keep changes scoped to the requested task.
- Run the narrowest useful verification for the change.
- If a frontend/GTK change affects visible UI, run or build enough to prove it
  still works.
