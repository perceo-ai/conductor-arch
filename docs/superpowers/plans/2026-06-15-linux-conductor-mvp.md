# Linux Conductor MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Linux-native MVP inspired by Conductor's workspace, agent, review, and pull request workflow, with support for the most common desktop Linux distributions on a 2-3 day build timeline.

**Architecture:** The app should separate workflow logic from presentation: a Rust core library owns repositories, worktrees, settings, scripts, process supervision, GitHub state, and agent session metadata; a CLI and optional native GUI call into that core. The MVP should treat Codex, Claude Code, shells, and editors as local processes launched inside isolated Git worktrees instead of depending on an agent-specific private protocol.

**Tech Stack:** Rust, SQLite, Git CLI/libgit2 where useful, `gh`, PTY/VTE, GTK4/libadwaita or Tauri, systemd user service where available, AppImage/Flatpak plus native distro packages.

---

## Product Scope

This project rebuilds the practical Conductor workflow for Linux, not the macOS app itself. Conductor is currently a macOS app; this MVP should be a Linux-native implementation of the same general workflow model:

- One shippable task gets one isolated workspace.
- Each workspace is a Git worktree with its own branch, files, terminals, agent sessions, run scripts, diff, checks, pull request path, and archive state.
- Multiple agents can run in parallel when their tasks can land independently.
- Multiple agents can share one workspace when they need the same branch and file state.
- The branch and pull request are the integration unit.

The first public MVP should be strong enough to demonstrate on LinkedIn:

1. Add a repository.
2. Create two or more Linux workspaces from the same repo.
3. Launch Codex, Claude Code, or a shell in each workspace.
4. Run setup and run scripts with separate ports.
5. Show changed files and unified diffs.
6. Push a branch and create a GitHub pull request.
7. Show PR checks and local todos.
8. Archive a workspace after merge or discard.

## 2-3 Day Build Constraint

The timeline is intentionally aggressive. Treat this as a focused Linux migration tool first and a polished multi-distro desktop product second.

Build the fastest credible version by cutting scope this way:

- Use Tauri plus a Rust backend for the first GUI, unless GTK/libadwaita is already familiar enough to avoid UI drag.
- Ship AppImage first, because it gives the fastest cross-distro demo path.
- Ship native `.deb`, `.rpm`, AUR, and Flatpak after the demo if they slow down core workflow delivery.
- Use shell commands and `gh` for GitHub instead of building a full API client.
- Use embedded or external terminal sessions depending on which path is faster; PTY logging is more important than perfect terminal UI in the first build.
- Implement a basic unified diff viewer, not a full review UI.
- Implement checks through `gh pr checks`, not full unresolved review thread GraphQL.
- Skip checkpoint restore until after the public demo unless the core workflow finishes early.
- Skip Linear, Cursor hosted sessions, cloud workspaces, organization-managed settings, and plugin systems.

### Day 1: Core Workflow

Deliver by end of day:

- CLI binary that can add a repo, create/list/archive workspaces, and start a shell in a workspace.
- Git worktree creation from latest remote base.
- `.context/` creation.
- `.worktreeinclude` and `file_include_globs` copying for ignored files.
- setup script execution.
- stable `CONDUCTOR_PORT` allocation.
- distro-aware `doctor` command for Ubuntu/Debian, Fedora, Arch, and openSUSE.

Demo proof:

```bash
linux-conductor repo add ~/src/app
linux-conductor workspace create app --name berlin --branch lc/berlin-demo
linux-conductor workspace create app --name tokyo --branch lc/tokyo-demo
linux-conductor session start berlin --kind shell
linux-conductor run berlin
```

### Day 2: PR And Review Loop

Deliver by end of day:

- Codex and Claude Code launchers.
- run/stop process supervision.
- logs per workspace.
- changed file list.
- unified diff command.
- push branch.
- create PR with `gh`.
- checks with `gh pr checks`.
- archive workspace after merge or discard.

Demo proof:

```bash
linux-conductor session start berlin --kind codex
linux-conductor diff berlin
linux-conductor pr create berlin
linux-conductor checks berlin
linux-conductor archive berlin
```

### Day 3: GUI And Packaging

Deliver by end of day:

- Tauri or GTK GUI shell with sidebar, session pane, diff/checks panel, and top actions.
- AppImage release artifact.
- basic `.deb` and `.rpm` artifacts if time permits.
- README with install commands, tested distros, known limits, and demo walkthrough.
- short screen recording showing two parallel workspaces, one PR, checks, and archive.

Day 3 can be cut down if needed: AppImage plus a polished CLI demo is acceptable if the GUI is not stable. A broken GUI is worse than a reliable CLI with a clean terminal-based walkthrough.

## Target Distributions

Support should be organized in tiers so the MVP is credible without becoming a packaging project first.

### Tier 1: Official MVP Targets

- Ubuntu LTS 24.04 and newer.
- Debian 12 and newer.
- Fedora Workstation 40 and newer.
- Arch Linux.

These cover the most common developer desktops across Debian-based, Fedora/RHEL-style, and rolling-release ecosystems.

### Tier 2: Early Compatible Targets

- openSUSE Tumbleweed and Leap.
- Linux Mint, Pop!_OS, Zorin OS, and other Ubuntu derivatives.
- Manjaro and EndeavourOS as Arch derivatives.

These should work through AppImage or Flatpak first, with native packages later if demand appears.

### Tier 3: Not MVP Blocking

- NixOS.
- Alpine Linux.
- immutable desktops that require special packaging or portals beyond standard Flatpak behavior.
- WSL.

Do not block the MVP on these. Document what works and what is untested.

## Packaging Strategy

The packaging strategy should prioritize broad installation first, then native polish.

### MVP Install Options

1. AppImage for the fastest broad Linux desktop install.
2. `.deb` package for Ubuntu and Debian.
3. `.rpm` package for Fedora and openSUSE.
4. AUR package for Arch users.
5. Flatpak after the MVP, unless sandbox constraints are solved quickly.

### Release Tooling

Use one release pipeline to build all artifacts:

- `cargo build --release` for CLI/core.
- `cargo deb` or `nfpm` for `.deb`.
- `cargo generate-rpm` or `nfpm` for `.rpm`.
- `appimagetool` for AppImage.
- Flatpak manifest for the GUI package.
- GitHub Actions matrix for Ubuntu, Fedora container, and Arch container builds.

Use `nfpm` if the goal is speed and consistent metadata across `.deb` and `.rpm`.

### Runtime Dependencies

Required:

- `git`
- `sqlite`
- `openssh`
- `github-cli` / `gh`
- a POSIX shell

GUI package dependencies:

- GTK4
- libadwaita
- VTE
- desktop portal support where needed

Optional:

- `codex`
- `claude`
- `code`
- `cursor`
- `podman` or `docker`
- `just`, `make`, `npm`, `pnpm`, language runtimes used by target repositories

The app should detect missing optional tools and show exact install guidance per distro.

## Install Commands By Distro

The CLI should expose:

```bash
linux-conductor doctor
```

The doctor command should detect the distro from `/etc/os-release` and print relevant commands.

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install git gh sqlite3 openssh-client
```

Fedora:

```bash
sudo dnf install git gh sqlite openssh-clients
```

Arch:

```bash
sudo pacman -S git github-cli sqlite openssh
```

openSUSE:

```bash
sudo zypper install git gh sqlite3 openssh
```

Flatpak builds should document that host access is required for meaningful local repository and agent execution. If the Flatpak sandbox becomes a blocker for PTY, file system, or process control, ship AppImage as the recommended MVP desktop installer and keep Flatpak experimental.

## Data Locations

Follow the XDG base directory specification:

```text
~/.config/linux-conductor/config.toml
~/.local/share/linux-conductor/linux-conductor.db
~/.local/state/linux-conductor/logs/
~/.cache/linux-conductor/
```

Default workspaces:

```text
~/conductor/workspaces/<repo-name>/<workspace-name>/
```

Keep this path compatible with Conductor's common workspace shape so users can understand both systems easily.

Each workspace gets:

```text
<workspace>/.context/
```

The `.context` directory is gitignored and holds task notes, handoffs, review comments, and agent scratch context.

## Conductor-Compatible Repository Settings

Read repository configuration from:

```text
<repo>/.conductor/settings.toml
<repo>/.conductor/settings.local.toml
<repo>/.worktreeinclude
```

Supported settings for MVP:

```toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

file_include_globs = """
.env*
config/*.local.json
"""

[scripts]
setup = "pnpm install"
run = "pnpm dev --port $CONDUCTOR_PORT"
archive = "./script/workspace-archive.sh"
run_mode = "concurrent"

[environment_variables]
API_BASE_URL = "http://localhost:3000"

[prompts]
general = "Prefer small, reviewable changes and run focused tests."
code_review = "Focus on correctness, behavior changes, and missing tests."
create_pr = "Write concise PR descriptions with test evidence."
```

Precedence:

1. Local machine config.
2. Repository local settings.
3. Repository shared settings.
4. Built-in defaults.

Do not implement managed enterprise settings in the MVP.

## Core Features

### Repository Registry

Store repositories with:

- display name
- root path
- default branch
- remote name
- workspace parent path
- settings file hashes
- last fetched time
- package ecosystem hints

CLI examples:

```bash
linux-conductor repo add ~/src/my-app
linux-conductor repo list
linux-conductor repo doctor my-app
```

### Workspace Creation

CLI example:

```bash
linux-conductor workspace create my-app --name tel-aviv --base origin/main --branch feat/search-refactor
```

Behavior:

1. Fetch `origin` with pruning.
2. Resolve the configured base branch.
3. Create a branch from the latest remote base.
4. Add a Git worktree at the workspace path.
5. Create `.context/`.
6. Copy eligible gitignored files using `.worktreeinclude` or `file_include_globs`.
7. Allocate a stable block of ten ports.
8. Run the setup script if configured.
9. Persist workspace metadata in SQLite.

Environment variables:

```bash
CONDUCTOR_WORKSPACE_NAME
CONDUCTOR_WORKSPACE_PATH
CONDUCTOR_ROOT_PATH
CONDUCTOR_DEFAULT_BRANCH
CONDUCTOR_PORT
CONDUCTOR_IS_LOCAL=1
```

### Files To Copy

Only copy files when both conditions are true:

1. The file is ignored by Git.
2. The file matches `.worktreeinclude` or `file_include_globs`.

Do not copy dependency directories, build outputs, or unignored files by default.

Use `.gitignore` syntax for patterns:

```text
.env*
config/local.json
certs/local/**
!certs/local/README.md
```

### Run Scripts

CLI examples:

```bash
linux-conductor run tel-aviv
linux-conductor stop tel-aviv
linux-conductor logs tel-aviv --run
```

Behavior:

- Run scripts execute from the workspace directory.
- `CONDUCTOR_PORT` is available.
- `scripts.run_mode = "concurrent"` allows multiple workspaces in the same repo to run together.
- `scripts.run_mode = "nonconcurrent"` allows one running workspace per repo.
- Processes run in a process group.
- Stop sends SIGHUP or SIGTERM, waits briefly, then sends SIGKILL if needed.

### Agent Sessions

Supported MVP session kinds:

- shell
- Codex
- Claude Code
- editor launcher

CLI examples:

```bash
linux-conductor session start tel-aviv --kind codex
linux-conductor session start tel-aviv --kind claude
linux-conductor session start tel-aviv --kind shell
linux-conductor open tel-aviv --editor code
```

Launch all sessions from the workspace directory. Store:

- session kind
- command
- PTY log path
- status
- start and end time
- linked workspace

### Coordination

Workspace coordination files:

```text
.context/brief.md
.context/agent-notes.md
.context/review-comments.json
.context/todos.md
```

The app should also keep normalized todos and comments in SQLite.

Rules:

- Separate workspaces for independent PRs.
- Same workspace for agents collaborating on one branch.
- Warn when multiple live sessions are editing the same workspace.
- Warn when two active workspaces modify the same high-churn files.

### Diff Viewer

MVP commands:

```bash
git status --short
git diff --stat
git diff --name-only
git diff -- <file>
```

UI requirements:

- changed file list
- unified diff
- untracked/staged/unstaged indicators
- local comments attached to file and line
- revert file action with confirmation
- send selected review comments into an active agent session

### Checks Panel

The checks panel should show:

- Git status
- branch push state
- PR metadata
- CI status
- deployments when available
- unresolved review comments when available
- local todos
- run script status
- last verification command

Initial implementation can use:

```bash
gh pr view --json number,title,state,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr checks
```

Use GitHub GraphQL later for high-fidelity unresolved review thread state.

### Pull Request Flow

CLI examples:

```bash
linux-conductor pr create tel-aviv
linux-conductor pr checks tel-aviv
linux-conductor pr merge tel-aviv
```

Behavior:

1. Verify workspace has changes.
2. Show diff summary.
3. Push branch with upstream if needed.
4. Generate PR title/body from branch, commits, and diff summary.
5. Allow user edit before submission.
6. Create PR with `gh pr create`.
7. Store PR URL and number.
8. Poll checks.
9. Block merge by default when checks fail, todos are open, or review threads are unresolved.

### Archive And Restore

Archive behavior:

1. Stop running sessions and run scripts.
2. Run archive script if configured.
3. Mark workspace archived in SQLite.
4. Optionally remove the worktree.
5. Optionally delete branch after merge.
6. Preserve logs, PR metadata, and context snapshot.

Restore behavior:

1. Recreate worktree from branch if missing.
2. Restore workspace metadata.
3. Show prior logs and context.
4. Require manual relaunch for agents and run scripts.

### Checkpoints

Create private Git refs before each user-submitted agent prompt:

```text
refs/linux-conductor/checkpoints/<workspace-id>/<session-id>/<turn-id>
```

Store:

- checkpoint ref
- session id
- turn id
- prompt summary
- created timestamp

Restore behavior:

- Show exactly what will be reverted.
- Require confirmation.
- Reset tracked and untracked workspace state to the selected checkpoint.
- Warn when multiple sessions have modified the workspace after that checkpoint.

Checkpoints are useful but risky. They should not block the first public MVP if the rest of the workflow is solid.

### MCP Status

Do not proxy MCP in v1. Surface existing agent configuration:

- Claude user config: `~/.claude.json`
- Claude project config: `.mcp.json`
- Codex user config: `~/.codex/config.toml`
- Codex project config: `.codex/config.toml`
- Cursor user config: `~/.cursor/mcp.json`
- Cursor project config: `.cursor/mcp.json`

CLI examples:

```bash
linux-conductor mcp status tel-aviv
claude mcp list
codex mcp list
```

Show configured servers and whether the backing agent CLI can see them.

## Architecture

Recommended repository layout:

```text
linux-conductor/
  crates/
    core/
      src/settings.rs
      src/repository.rs
      src/workspace.rs
      src/files_to_copy.rs
      src/scripts.rs
      src/env.rs
    daemon/
      src/process_supervisor.rs
      src/pty.rs
      src/events.rs
    github/
      src/gh_cli.rs
      src/graphql.rs
      src/pr.rs
    agents/
      src/codex.rs
      src/claude.rs
      src/shell.rs
      src/editor.rs
    cli/
      src/main.rs
    gtk-app/
      src/main.rs
  packaging/
    appimage/
    flatpak/
    deb/
    rpm/
    aur/
  docs/
    user-guide.md
    packaging.md
```

SQLite schema:

```sql
CREATE TABLE repositories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  remote_name TEXT NOT NULL DEFAULT 'origin',
  workspace_parent_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  port_base INTEGER NOT NULL,
  status TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  pty_log_path TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE pull_requests (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  provider TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE todos (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE review_comments (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  file_path TEXT NOT NULL,
  line_number INTEGER,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  github_thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE checkpoints (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  session_id INTEGER REFERENCES sessions(id),
  turn_id TEXT NOT NULL,
  git_ref TEXT NOT NULL,
  prompt_summary TEXT,
  created_at TEXT NOT NULL
);
```

## User Interface Plan

### CLI MVP

The CLI should be complete enough to use without the GUI:

```bash
linux-conductor repo add ~/src/app
linux-conductor workspace create app --name tel-aviv --branch feat/foo
linux-conductor session start tel-aviv --kind codex
linux-conductor run tel-aviv
linux-conductor diff tel-aviv
linux-conductor pr create tel-aviv
linux-conductor checks tel-aviv
linux-conductor archive tel-aviv
```

### GUI MVP

Use Tauri if the 2-3 day deadline is the priority. Use GTK4/libadwaita only if the team can already move quickly with GTK, VTE, and packaging.

GUI layout:

- left sidebar: repositories and workspaces
- center: terminal/session tabs
- right panel: diff, checks, todos, PR state
- top workspace actions: Run, Stop, Open Editor, Create PR, Archive

Use VTE for embedded terminal sessions on GTK. If using Tauri, use a web terminal connected to the daemon's PTY stream when feasible; otherwise launch the user's default terminal for the first demo and keep logs visible in the app.

### Conductor-Inspired UI Direction

The UI should feel like a Linux-native cousin of Conductor, not a direct macOS clone.

Use these patterns:

- dark, dense workspace shell
- narrow left sidebar with repositories grouped by project
- city/workspace rows with branch, status, and small count badges
- central conversation or terminal surface
- compact top workspace header with branch, PR, run, and archive actions
- bottom composer or command bar for agent prompts
- right-side or tabbed review surface for changed files, checks, todos, and PR state
- visible run panel with port, command, and stop action

Saved wireframes:

- [Main workspace shell](../../ui-sketches/linux-conductor-main-workspace.svg)
- [New workspace flow](../../ui-sketches/linux-conductor-new-workspace.svg)
- [Review and checks panel](../../ui-sketches/linux-conductor-review-checks.svg)
- [UI sketches notes](../../ui-sketches/linux-conductor-ui-sketches.md)

## Implementation Phases

These phases are written for a normal implementation sequence. For the 2-3 day build, execute them as a vertical slice: only implement enough of each phase to satisfy the day-by-day timeline above.

### Phase 1: Linux CLI Core

- [ ] Create Rust workspace and crate structure.
- [ ] Add SQLite migrations.
- [ ] Implement XDG config/state/cache paths.
- [ ] Implement repository add/list/doctor.
- [ ] Parse `.conductor/settings.toml`, `.conductor/settings.local.toml`, and `.worktreeinclude`.
- [ ] Implement Git fetch, branch creation, and worktree creation.
- [ ] Create `.context/` and copy eligible ignored files.
- [ ] Allocate stable workspace port ranges.
- [ ] Run setup scripts with Conductor-compatible environment variables.
- [ ] Add unit tests for settings precedence and file-copy matching.
- [ ] Add integration tests that create temporary Git repos and worktrees.

### Phase 2: Process And Agent Runtime

- [ ] Implement PTY-backed process supervisor.
- [ ] Add shell sessions.
- [ ] Add Codex sessions.
- [ ] Add Claude Code sessions.
- [ ] Capture logs to `~/.local/state/linux-conductor/logs/`.
- [ ] Implement run script start/stop.
- [ ] Enforce `concurrent` and `nonconcurrent` run modes.
- [ ] Add `doctor` checks for missing `git`, `gh`, `codex`, and `claude`.
- [ ] Add distro-specific dependency guidance.

### Phase 3: Review And PR Workflow

- [ ] Implement changed file list and unified diff commands.
- [ ] Store local review comments.
- [ ] Store local todos.
- [ ] Implement push branch flow.
- [ ] Implement PR create flow through `gh`.
- [ ] Implement checks through `gh pr view` and `gh pr checks`.
- [ ] Add merge readiness rules.
- [ ] Implement archive and restore metadata.

### Phase 4: GUI MVP

- [ ] Build GTK/libadwaita shell.
- [ ] Add repository/workspace sidebar.
- [ ] Embed terminal sessions with VTE.
- [ ] Add workspace action buttons.
- [ ] Add diff panel.
- [ ] Add checks panel.
- [ ] Add PR creation dialog.
- [ ] Add archive confirmation.

### Phase 5: Packaging And Public Demo

- [ ] Add AppImage packaging.
- [ ] Add `.deb` packaging.
- [ ] Add `.rpm` packaging.
- [ ] Add AUR `PKGBUILD`.
- [ ] Add Flatpak manifest as experimental if sandbox constraints are acceptable.
- [ ] Add GitHub Actions release workflow.
- [ ] Test install on Ubuntu LTS, Debian, Fedora, Arch, and openSUSE.
- [ ] Record a demo with two parallel workspaces creating separate PRs.
- [ ] Publish installation docs and known limitations.

## MVP Acceptance Criteria

The MVP is ready to share publicly when all of these are true:

- A user on Ubuntu, Fedora, or Arch can install from a provided package or AppImage.
- `linux-conductor doctor` detects required dependencies and gives distro-specific install guidance.
- A user can add a GitHub-backed repository.
- A user can create at least two worktree workspaces from the same base branch.
- Each workspace has a unique branch, `.context/`, copied ignored env files, and a stable port range.
- Codex, Claude Code, or a shell can run inside each workspace.
- Setup and run scripts work from workspace directories.
- The app can show changed files and unified diff.
- The app can push a branch and create a GitHub PR.
- The app can show GitHub check status.
- The app can archive a workspace.
- The README clearly states supported distros, tested distros, and limitations.

## Known Risks

- Agent CLIs are not stable integration APIs. PTY-first execution keeps the MVP resilient.
- Flatpak sandboxing may conflict with local process supervision and arbitrary repository access.
- GitHub unresolved review thread support requires GraphQL for high fidelity.
- Checkpoint restore can destroy work if implemented casually.
- File-copy behavior can leak secrets if it copies too broadly; only copy ignored files that match explicit patterns.
- GUI terminal embedding differs across desktop environments; test GNOME, KDE, and tiling-window-manager setups.
- Some projects assume one fixed local database, Docker stack, or port. Respect `scripts.run_mode = "nonconcurrent"` and document limitations.

## LinkedIn Demo Narrative

The public MVP story should be simple:

> I wanted a Conductor-like parallel coding-agent workflow on Linux, so I built a native Linux MVP around Git worktrees. Each task gets its own branch, workspace, terminal, agent session, diff, checks, and PR path. It runs on Ubuntu, Fedora, Arch, and other common distros through AppImage plus native packages.

Demo flow:

1. Add a repository.
2. Create workspace `berlin` for a bug fix.
3. Create workspace `tokyo` for a UI polish task.
4. Start Codex in one and Claude Code in the other.
5. Run both apps on different ports.
6. Show separate diffs.
7. Create two PRs.
8. Show checks.
9. Archive one completed workspace.

## Source Notes

This plan is based on the documented Conductor workflow model:

- Conductor docs introduction: https://www.conductor.build/docs
- Workflow: https://www.conductor.build/docs/concepts/workflow
- Git worktrees: https://www.conductor.build/docs/concepts/git-worktrees
- Parallel agents: https://www.conductor.build/docs/concepts/parallel-agents
- Scripts: https://www.conductor.build/docs/reference/scripts
- Files to copy: https://www.conductor.build/docs/reference/files-to-copy
- Environment variables: https://www.conductor.build/docs/reference/environment-variables
- Diff viewer: https://www.conductor.build/docs/reference/diff-viewer
- Checks: https://www.conductor.build/docs/reference/checks
- Review and merge: https://www.conductor.build/docs/guides/review-and-merge
- MCP: https://www.conductor.build/docs/reference/mcp
