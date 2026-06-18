# Claude Agent Instructions

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

Be real with the user:

- Do not call a phase, feature, connector, or flow "done" unless it has current
  evidence from code, tests, CLI smoke, or GUI/runtime verification.
- Distinguish clearly between backend support, CLI support, GTK controls, and
  actual end-to-end product behavior. One layer does not prove the others.
- If auth, API keys, display server, network, local tools, or test data are
  missing, say exactly what was not verified.
- Do not market scaffolding as a feature. A button that calls nothing real is
  not a feature. A CLI path with no GTK path is not a GUI feature. A GTK path
  with no core behavior is not real.
- When progress docs are stale or too optimistic, fix them before continuing.

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

Current state as of the latest progress log:

- Phase 0, Phase 1, and Phase 2 have usable slices.
- Phase 3 must be treated as incomplete until every item in the Phase 3 section
  of `docs/conductor-gui-mvp-handoff.md` is proven across core/CLI/GTK where
  applicable.
- The GTK app is still a prototype, not a finished MVP.
- GitHub-backed flows require local `gh` auth. Linear-backed flows require
  `LINEAR_API_KEY`. MCP status currently means config inspection unless live
  reachability is explicitly tested.

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
6. Finish the workspace command center with real core + CLI + GTK behavior,
   not placeholder controls.
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
