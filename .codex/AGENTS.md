# Codex Agent Instructions

## Read This Every Time

Before touching code or docs in this repository, read these files in order:

1. `docs/conductor-gui-mvp-handoff.md`
2. `progress.md`
3. `docs/mvp-scope.md`
4. `docs/manual-testing-checklist.md`
5. `docs/conductor-docs-parity-map.md`
6. `README.md`

Also keep the official Conductor docs in mind as the parity baseline:

- `https://www.conductor.build/docs/concepts/workspaces-and-branches`
- `https://www.conductor.build/docs/concepts/workflow`
- `https://www.conductor.build/docs/concepts/parallel-agents`
- `https://www.conductor.build/docs/reference/settings`
- `https://www.conductor.build/docs/reference/scripts`
- `https://www.conductor.build/docs/reference/files-to-copy`
- `https://www.conductor.build/docs/reference/agent-modes`
- `https://www.conductor.build/docs/reference/diff-viewer`
- `https://www.conductor.build/docs/reference/checks`

Treat `docs/conductor-gui-mvp-handoff.md` as the source of truth for the
corrected MVP. The old direction over-indexed on CLI/backend work. The product
goal is a GUI-first Conductor-style desktop app that matches Conductor first.
Better-than-Conductor features come only after an explicit product decision.

## Operating Mode

Use caveman mode:

- Move fast.
- Keep changes direct and obvious.
- Prefer working product increments over architecture theater.
- Do not invent broad abstractions unless they remove immediate complexity.
- Do not add backend-only commands unless they unblock the GUI-first MVP.
- Implement, verify, and keep going.
- Leave concise notes when something is incomplete or blocked.

Use Superpowers:

- Invoke relevant Superpowers skills before doing work.
- Use systematic debugging for bugs.
- Use TDD where practical for behavior changes.
- Use verification-before-completion before claiming something is done.
- Use subagents or separate Conductor workspaces for independent work when that
  helps finish faster.

There are enough credits. Optimize for throughput while keeping the codebase
coherent.

## Current Project State

This repo is in Phase 1 transition after the Phase 0 docs reset:

- Phase 0 documentation reset is complete enough to use as the baseline.
- The backend/core/CLI foundation is substantial.
- The GTK app is still a prototype, not a finished MVP.
- The next real product work is GUI architecture cleanup and then the missing
  Conductor surfaces: settings, workspace creation, embedded runtime,
  app-native agents, review/checks/PRs, history, command palette, shortcuts,
  deep links, provider/MCP status, and safety/privacy.

Do not describe the project as MVP complete. Do not call packaging
release-ready until the GUI-first flow works without normal CLI coordination.

## Implementation Priorities

Follow the handoff phases:

1. Keep docs aligned with the corrected GUI-first MVP.
2. Split `crates/gtk-app/src/main.rs` into focused modules.
3. Define explicit app state for selected project, selected workspace, active
   page/tab, running sessions, and processes.
4. Replace ad hoc refresh closures with a clear refresh/event model.
5. Build polished project onboarding and settings.
6. Build the workspace command center.
7. Add embedded terminal/runtime support.
8. Add app-native Claude Code, Codex, and Cursor session surfaces.
9. Build real git/diff/review and GitHub PR/check/merge GUI workflows.
10. Add command palette, keyboard shortcuts, deep links, provider settings, MCP
    status, Spotlight testing, Big Terminal Mode, monorepo controls, and linked
    directory workflows.
11. Finish history/restore and release validation.

## Engineering Rules

- Work from this workspace unless explicitly told otherwise.
- Target branch is `origin/main`; do not rename the current branch.
- Check `git status --short` before edits and before final response.
- Do not revert user or other-agent changes unless explicitly asked.
- Use `rg`/`rg --files` for search.
- Use `apply_patch` for manual file edits.
- Keep changes scoped to the requested phase/task.
- Run the narrowest useful verification for the change.
- If a frontend/GTK change affects visible UI, run or build enough to prove it
  still works.

## Product North Star

Conductor is a local desktop control plane for parallel coding agents:

- Projects wrap repositories.
- Workspaces are Git worktrees and branches.
- Agents run inside workspaces.
- The GUI shows agent state, runtime state, changes, checks, todos, comments,
  PR state, and history.
- The GUI owns setup/settings, app controls, provider/MCP status, review
  blockers, archive/restore, and safety/privacy messaging.
- The user should not need to juggle many terminals for normal workflow
  coordination.
