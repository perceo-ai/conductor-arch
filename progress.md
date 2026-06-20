# Progress

## Current State

Linux Conductor now has a usable app-first loop for one repository:

1. Add or clone a repository.
2. Configure repository settings.
3. Create branch, prompt, GitHub issue, GitHub PR, or Linear workspaces.
4. Run multiple Shell/Codex/Claude/Cursor sessions in a workspace.
5. Use workspace terminal, setup/run scripts, logs, and process views.
6. Review diffs, todos, local comments, sibling conflicts, PR checks, and PR
   comments.
7. Stage review/check/comment context into a selected agent session.
8. Create, refresh, merge, and optionally archive GitHub PRs through local
   `gh` auth.
9. Restore archived workspaces and inspect older imported Conductor chats.

The GTK app is usable but still rough. Agent sessions are PTY/transcript based,
terminal rendering is not a full emulator, and several app controls remain
unfinished.

Latest verification on 2026-06-20: `cargo test -p linux-conductor-core --lib`
passed after the dead-session reconciliation test fix. Broader CLI/GTK suites
should be run before release artifacts.

## Implemented

### Core And CLI

- Rust workspace with core, CLI, and GTK crates.
- SQLite-backed repository, workspace, process, PR, todo, review, and checkpoint
  state.
- Repository add/list/update/doctor.
- Import from the macOS Conductor database.
- Workspace create/list/archive/restore/discard/rename.
- Real Git worktree creation with `.context` initialization.
- Workspace creation from branch/base, prompt, GitHub issue, GitHub PR, and
  Linear issue.
- GitHub PR workspace creation fetches the PR head ref before creating the
  worktree.
- Linear creation uses `LINEAR_API_KEY` and fails clearly when it is missing.
- Setup/run/archive script plumbing from `.conductor/settings.toml`.
- Shared/local repository settings load/save, including scripts, run mode,
  Spotlight testing, Files to copy, environment variables, durable prompts,
  provider executable/provider fields, and Git behavior flags.
- Repository action prompts are part of the editable settings model; the app
  should keep them first-class because prompt iteration is core to agent work.
- `.worktreeinclude` precedence over `file_include_globs`.
- Stable per-workspace port allocation.
- Background setup/run/session process rows, logs, exit codes, stop handling,
  and stale-process reconciliation.
- Workspace-scoped one-shot terminal commands.
- PTY-backed shell primitive with input, output, resize, process records, and
  transcript logs.
- Shell/Codex/Claude/Cursor session launch primitives.
- Codex and Claude launches honor configured executable paths.
- First Spotlight testing slice: checkpoint/apply/sync/switch/restore tracked
  workspace patches against a clean repository root, with dirty-root refusal and
  explicit repair.
- Git status/diff/log helpers.
- Todo, review comment, checkpoint, conflict, and checks-summary commands.
- GitHub PR create/view/checks/comments/merge through local `gh` auth.
- PR merge blocks open todos and open local review comments.
- PR merge can archive the workspace when `git.archive_on_merge = true`.
- PR checks/comments can be converted into agent prompts.
- Packaging scaffolding for AppImage, deb, rpm, AUR, and Flatpak.

### GTK App

- Native GTK/libadwaita app with Dashboard, Projects, History, and Workspace
  pages.
- Sidebar workspace search/grouping.
- Projects page can add local repos, clone Git URLs, list projects, edit
  shared/local settings, and create workspaces from branch/base, GitHub issue,
  GitHub PR, Linear issue, or prompt.
- Workspace command center with status header, agents panel, runtime panel,
  changes/checks/review tabs, chat/terminal split, todos, processes, and
  lifecycle controls.
- Agent panel starts PTY-backed Shell, Codex, Claude, and Cursor sessions,
  persists transcripts, sends input, stops selected sessions, creates
  checkpoints, shows harness metadata, surfaces provider/auth/MCP status, and
  sends staged review prompts.
- Terminal panels support one-shot commands, PTY shells, multiple shell tabs,
  transcript persistence/search/history/reload, basic ANSI/control redraw
  handling, and resize propagation.
- Runtime panel runs setup/run scripts, stops run scripts, shows log tails, and
  controls the current Spotlight slice.
- Changes tab has changed-file tree, per-file unified diff preview, full-diff
  fallback, recent commits, branch push state, git status, file-scoped comments,
  and safe tracked-file revert.
- Review tab can add/resolve local file comments and stage open comments for the
  selected agent session.
- Checks tab can create/refresh PR state, inspect raw PR checks and PR
  comments/reviews, stage failures/comments for the selected agent session, show
  merge blockers, merge PRs, and archive after merge through repository
  settings.
- Conflict panel detects sibling workspaces that changed the same files and can
  preview or copy sibling file changes.
- History page can read old chats from the macOS Conductor database when
  available.

## Known Gaps

- Agent chat is transcript-oriented, not a polished structured message UI with
  attachments.
- Terminal rendering handles common ANSI/control redraws but is not a full
  terminal emulator.
- Command palette, broad keyboard shortcuts, deep links, and polished Big
  Terminal Mode are not complete.
- Monorepo directory selection and linked-directory workflows are not complete.
- GitHub review-thread sync and deployment/check aggregation are still raw.
- Unified local history for all new chats is not complete.
- Project onboarding/settings need more polish and fuller user/managed settings
  visibility.
- Theme/view customization needs a documented config-file model. Not every
  advanced visual or layout option needs a bespoke GUI control.
- Visual parity with Conductor is not complete.
- Release packaging still needs full manual validation on target distros.

## Documentation

- Public overview: [`README.md`](README.md)
- End-to-end validation: [`docs/manual-testing-checklist.md`](docs/manual-testing-checklist.md)
- Local deploy/test guide: [`docs/deploy-and-local-test.md`](docs/deploy-and-local-test.md)
- Conductor parity references: [`docs/conductor-docs-parity-map.md`](docs/conductor-docs-parity-map.md)

Keep docs grounded in verified app/core behavior. When a feature exists only in
core, CLI, or GTK, say which layer was verified.
