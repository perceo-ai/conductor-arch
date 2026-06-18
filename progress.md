# Progress

## Current State

This project has completed the Phase 0 documentation reset for the corrected
GUI-first MVP plan. The next implementation phase is app architecture cleanup.

The codebase is being redirected from a CLI-heavy worktree tool into a
GUI-first Conductor-style desktop app. The CLI and core backend are useful
foundation, but they are not the product experience by themselves.

The previous progress log overstated the GUI as "MVP complete." That was
incorrect. The corrected MVP definition is in:

- [`docs/conductor-gui-mvp-handoff.md`](docs/conductor-gui-mvp-handoff.md)
- [`docs/mvp-scope.md`](docs/mvp-scope.md)

Phase 0 now uses the official Conductor docs as the parity baseline. Match
Conductor's documented workflow first: repository setup, isolated workspaces,
agent sessions, runtime, diff review, checks, todos, PR flow, archive/history,
settings, command palette, shortcuts, deep links, provider settings, MCP, and
security/privacy posture.

## What Exists

### Backend/Core Foundation

- Rust workspace with core, CLI, and GTK crates.
- SQLite-backed repository, workspace, process, PR, todo, review, and checkpoint
  state.
- Repository add/list/update/doctor.
- Import from the macOS Conductor database.
- Workspace create/list/archive/restore/discard/rename.
- Real Git worktree creation.
- `.context` initialization.
- setup/run/archive script plumbing from `.conductor/settings.toml`.
- Stable per-workspace port allocation.
- Background run scripts and logs.
- Shell/Codex/Claude/Cursor session launch primitives.
- Git status/diff/log helpers.
- Todo, review comment, checkpoint, conflict, and checks-summary commands.
- GitHub PR create/view/checks/merge through local `gh` auth.
- Packaging scaffolding for AppImage, deb, rpm, AUR, and Flatpak.

### GTK Prototype

- Native GTK window with navigable Dashboard, Projects, History, and Workspace
  pages.
- Sidebar workspace search/grouping.
- Dashboard columns.
- Projects page can add local repos, clone Git URLs, list projects, and create
  workspaces.
- Workspace page has basic actions and rough tabs for chats, changes, checks,
  todos, and processes.
- History page can read old chats from the macOS Conductor database when
  available.

## What Is Not Done

The actual GUI-first Conductor MVP is not complete.

MVP-critical missing work:

- Embedded Conductor-native Claude/Codex/Cursor chat.
- Embedded workspace terminal.
- Big Terminal Mode direction.
- GUI-first project settings editor.
- Files to copy / `.worktreeinclude` UI and settings-layer visibility.
- Spotlight testing.
- Provider settings and MCP status.
- Agent controls: Plan Mode, Fast Mode, reasoning/effort, Codex personality,
  Codex goals, checkpoints, skills, and tool approvals where supported.
- Polished repository/workspace creation flows.
- Workspace creation from branch, PR, GitHub issue, Linear issue, and prompt.
- Real diff/review/comment surface.
- GUI-first GitHub PR/check/review/merge flow.
- Command palette, keyboard shortcuts, and deep links.
- Monorepo sparse-checkout controls and linked-directory workflows.
- Agent status model and resumable in-app session history.
- Unified local history model for archived workspaces and chats.
- Robust confirmations, progress, error states, refresh, and toasts.
- Visual parity with Conductor.
- Release-ready packaging validation.

## Next Step

Do not continue adding backend-only commands until the docs and app architecture
are aligned around the GUI-first MVP.

Recommended next work:

1. Keep local docs aligned with the official Conductor docs before adding
   better-than-Conductor product ideas.
2. Begin Phase 1 by refactoring `crates/gtk-app/src/main.rs` into
   page/component modules.
3. Define the app state model for projects, workspaces, selected page/tab,
   selected agent session, running processes, review/checks attention state,
   and settings layer.
4. Replace ad hoc refresh closures with a clear refresh/event model.
5. Build the embedded agent session and terminal foundation.
