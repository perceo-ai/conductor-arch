# Linux Conductor

Linux Conductor is a desktop control plane for running coding agents across
isolated Git worktree workspaces.

Use it when one repository has several streams of work in flight: create a
workspace, start Codex or Claude Code, review the diff, open or merge a GitHub
pull request, archive the workspace, then start the next task without leaving
the app.

Inspired by [Conductor](https://conductor.build). This project targets Linux
desktops with GTK4/libadwaita.

## What Works Today

The current app supports the core Conductor-style loop, with some rough edges:

- Add an existing repository or clone a Git URL from the Projects page.
- Create workspaces from a branch, prompt, GitHub issue, GitHub PR, or Linear
  issue.
- Give each workspace its own Git worktree, branch, `.context` directory, and
  stable `CONDUCTOR_PORT` range.
- Run multiple workspaces for the same repository in parallel.
- Start multiple Shell, Codex, Claude Code, or Cursor sessions inside one
  workspace.
- Use an embedded workspace terminal, setup/run/stop controls, logs, and process
  lists.
- Review changed files, file diffs, todos, local review comments, sibling
  workspace conflicts, PR checks, and GitHub PR comments.
- Stage review comments, failing checks, or PR comments into the selected agent
  session.
- Create, refresh, merge, and archive GitHub PRs from the workspace view through
  local `gh` auth.
- Restore archived workspaces and read older macOS Conductor chat history when
  that database is available.
- Customize repository behavior with editable prompts, scripts, environment,
  provider paths, Git behavior, and file-copy rules.

The GUI is usable, but not fully polished. Agent sessions and terminals are
PTY/transcript based rather than rich message surfaces. Command palette,
shortcut coverage, deep links, monorepo directory selection, linked-directory
workflows, theme/view configuration, and full Conductor visual parity are still
in progress.

## The Workflow

1. Open `linux-conductor-gtk`.
2. Add or clone a repository on the Projects page.
3. Configure repository scripts and settings if the project needs them.
4. Create a workspace for the next task.
5. Start Codex, Claude Code, Cursor, or a shell from the workspace page.
6. Work in the agent chat or embedded terminal.
7. Review changes, todos, comments, checks, and conflicts in the workspace.
8. Create a PR from the Checks tab.
9. Send failing checks or review comments back to an agent if needed.
10. Merge the PR and archive the workspace.
11. Repeat for the same repository or another repository.

Normal work should happen in the app. The CLI remains available for automation,
debugging, and fallback workflows.

## Install

### AppImage

```bash
curl -Lo linux-conductor.AppImage \
  https://github.com/pranavkannepalli/conductor-arch/releases/latest/download/linux-conductor-x86_64.AppImage
chmod +x linux-conductor.AppImage
sudo mv linux-conductor.AppImage /usr/local/bin/linux-conductor
```

Run the app:

```bash
linux-conductor
```

The AppImage opens the GTK app with no arguments and forwards CLI arguments to
the command-line interface.

### Build From Source

Install GTK4/libadwaita and Rust first:

```bash
# Ubuntu / Debian
sudo apt update
sudo apt install git gh sqlite3 openssh-client pkg-config libgtk-4-dev libadwaita-1-dev

# Fedora
sudo dnf install git gh sqlite openssh-clients pkgconf-pkg-config gtk4-devel libadwaita-devel

# Arch Linux
sudo pacman -S --needed git github-cli sqlite openssh pkgconf gtk4 libadwaita

# Rust
curl https://sh.rustup.rs -sSf | sh
```

Build and run:

```bash
git clone https://github.com/pranavkannepalli/conductor-arch
cd conductor-arch
cargo build --workspace --release --locked
./target/release/linux-conductor-gtk
```

Optional install:

```bash
sudo install -Dm755 target/release/linux-conductor /usr/local/bin/linux-conductor
sudo install -Dm755 target/release/linux-conductor-gtk /usr/local/bin/linux-conductor-gtk
```

## Requirements

| Tool | Required For |
| --- | --- |
| `git` | Worktrees, branches, diffs, commits |
| `gh` | GitHub PR creation, checks, comments, merge |
| `openssh` | SSH repository access |
| `codex` | Codex sessions |
| `claude` | Claude Code sessions |
| `cursor` or `code` | Editor/session launch when configured |

Run `gh auth login` before using PR features. Codex and Claude Code use your
existing local CLI authentication.

## Repository Settings

Shared project settings live at `.conductor/settings.toml` in the repository
root. Commit this file when teammates should get the same setup.

```toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

file_include_globs = """
.env*
config/*.local.json
"""

spotlight_testing = false

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

[git]
archive_on_merge = true
```

Local machine overrides live at `.conductor/settings.local.toml`. Do not commit
secrets.

Use `.worktreeinclude` when new workspaces should copy gitignored local files:

```text
.env*
config/*.local.json
certs/local/**
```

Only gitignored files are copied. Generated files and dependency installs
belong in `scripts.setup`.

### Script Environment

Setup, run, archive, terminal, and agent processes receive Conductor context:

| Variable | Value |
| --- | --- |
| `CONDUCTOR_WORKSPACE_NAME` | Workspace name |
| `CONDUCTOR_WORKSPACE_PATH` | Absolute path to the worktree |
| `CONDUCTOR_ROOT_PATH` | Absolute path to the main repository |
| `CONDUCTOR_DEFAULT_BRANCH` | Repository default branch |
| `CONDUCTOR_PORT` | Base port for this workspace |
| `CONDUCTOR_IS_LOCAL` | `1` |

`scripts.run_mode = "concurrent"` lets multiple workspaces run at once.
`"nonconcurrent"` allows only one active run script per repository.

Spotlight testing is available for projects that must run from the repository
root. The current implementation can checkpoint, apply, sync, switch, repair,
and restore tracked workspace changes, but it is still less polished than the
normal worktree runtime.

## Customization

Linux users should be able to make the app fit their workflow. The rule of
thumb is:

- Frequently edited workflow prompts should be editable in the app.
- Repository setup should be automated through committed setup/run/archive
  scripts.
- Advanced appearance, layout, theme, and view preferences can live in config
  files instead of crowding the UI.
- Team defaults belong in shared repository settings.
- Machine-specific preferences and secrets belong in local or user settings.

Customization areas that should be first-class:

### Prompts

Prompts are part of daily agent work, so they should be editable in the app:

- General agent instructions.
- Code review instructions.
- PR creation instructions.
- Failing check repair instructions.
- Merge conflict resolution instructions.
- Branch naming/rename instructions.
- Commit message generation instructions.
- Test-fixing instructions.
- Refactor style instructions.
- Staged prompts generated from local review comments, PR comments, checks,
  todos, conflicts, and selected diffs.
- Prompt profiles or prompt packs, such as `strict-review`, `fast-prototype`,
  `security-heavy`, or `docs-heavy`.
- Final prompt preview before launching an agent.

### Naming And Git Style

Teams should be able to encode their Git conventions once:

- Branch name templates, such as `lc/{workspace}`, `{type}/{slug}`,
  `{issue_key}-{slug}`, or `{github_issue}-{slug}`.
- Workspace name style: generated city names, prompt slug, issue key, branch
  slug, or custom templates.
- Commit message style: conventional commits, terse lowercase, team template, or
  "include tests run" format.
- PR title source: branch, first commit, issue title, prompt summary, or custom
  template.
- PR body sections: Summary, Tests, Screenshots, Risk, Rollback, Follow-ups.
- Default merge strategy: squash, merge, or rebase.
- Archive-after-merge default.

### Repository Automation

Repositories should be able to bootstrap themselves:

- Setup/run/archive scripts.
- Auto-run setup after workspace creation.
- Auto-start a preferred agent after setup.
- Required local file checks for `.env`, certs, tokens, or config files.
- Pre/post hooks for clone, workspace creation, setup, PR creation, merge, and
  archive.
- Per-workspace environment generation.
- Script presets for tests, lint, typecheck, build, seed, reset, and local
  services.

### Agent Defaults

Agent behavior should be configurable per user, repository, workspace, and
session profile:

- Default agent per repository.
- Agent profiles: planning, fast prototype, review-only, tests-first,
  refactor-only, docs-only.
- Default approval mode.
- Default reasoning or effort level.
- Default Codex personality/goals where supported.
- Default MCP visibility and status checks.
- Allowed or disallowed tools by repository or workspace.

### Review And Merge Rules

Merge readiness should match the team's definition of done:

- Configurable merge blockers for open todos, unresolved comments, failed
  checks, sibling workspace conflicts, uncommitted changes, missing tests, or
  missing PR description sections.
- Required checklist before PR creation.
- Required checklist before merge.
- Custom "definition of done" text shown in the workspace.
- Rules for when agent-generated work must be reviewed manually.

### Workspace Defaults

Workspace creation should be fast and predictable:

- Default base branch.
- Workspace parent directory.
- Branch prefix and slug style.
- Default port block size.
- Files to copy policy.
- Auto-open workspace after creation.
- Auto-create checkpoints on agent start, before PR, before merge, and before
  archive.
- Default tabs/panels to show when a workspace opens.

### View, Theme, And Layout

Not every visual option needs a button. Good file-editable settings include:

- Light, dark, or system theme.
- Accent color.
- Density: compact, normal, spacious.
- Sidebar grouping and sorting.
- Default workspace tab.
- Show/hide panels.
- Unified or side-by-side diff preference.
- Terminal font, size, and scrollback.
- Agent transcript font, wrapping, and timestamps.
- Dashboard columns and status labels.

### Notifications, Shortcuts, And Commands

Power users should be able to tune attention and speed:

- Toasts vs quiet mode.
- Alerts when agents stop, checks fail/pass, PR comments arrive, or conflicts
  appear.
- User-editable keybindings.
- Custom command palette entries.
- Repository-specific terminal presets.
- Import/export for settings bundles and prompt packs.

The current implemented settings format is TOML. Future theme/view
customization can use the same settings model or a dedicated file format, but
the public docs should not require every advanced knob to have a custom GUI
control.

## Platform Stance

Linux is the primary target. The code should keep a portable core where
practical, but product decisions should optimize for Linux desktop quality
first.

- Linux: primary supported platform.
- WSL: likely the best first Windows-adjacent target after Linux.
- macOS: technically possible, but lower priority because the original
  Conductor app already serves macOS and GTK packaging is less native there.
- Native Windows: possible later, but process groups, PTYs, paths, shells,
  signals, and packaging need deliberate platform abstraction before it is a
  realistic support target.

## CLI Reference

The CLI mirrors the app backend and is useful for smoke tests:

```bash
linux-conductor doctor

linux-conductor repo add <path> [--name <name>]
linux-conductor repo list
linux-conductor repo doctor [<name>]

linux-conductor workspace create <repo> --name <name> --branch <branch> [--base <ref>]
linux-conductor workspace create <repo> --from-issue <number>
linux-conductor workspace create <repo> --from-pr <number>
linux-conductor workspace create <repo> --from-linear <issue-id>
linux-conductor workspace create <repo> --prompt <prompt>
linux-conductor workspace list
linux-conductor workspace archive <name> [--remove-worktree]
linux-conductor workspace restore <name>
linux-conductor workspace discard <name>
linux-conductor workspace rename <name> <new-name>

linux-conductor session start <workspace> --kind shell|codex|claude|cursor
linux-conductor session open <workspace> --kind shell|codex|claude|cursor
linux-conductor session stop <workspace>
linux-conductor session list <workspace>

linux-conductor run <workspace>
linux-conductor stop <workspace>
linux-conductor logs <workspace> --run|--session

linux-conductor diff <workspace> [--name-only] [--file <path>]
linux-conductor checks <workspace>
linux-conductor conflicts <workspace>

linux-conductor todo add <workspace> <text...>
linux-conductor todo list <workspace>
linux-conductor todo done <id>

linux-conductor review add <workspace> <file> [--line <n>] <body...>
linux-conductor review list <workspace>
linux-conductor review resolve <id>

linux-conductor pr create <workspace> [--title <title>] [--body <body>] [--draft]
linux-conductor pr view <workspace>
linux-conductor pr checks <workspace>
linux-conductor pr merge <workspace> [--method squash|merge|rebase]

linux-conductor checkpoint create <workspace> [--session <id>] <message...>
linux-conductor checkpoint list <workspace>
linux-conductor checkpoint restore <workspace> <id>
```

## Data Locations

```text
~/.config/linux-conductor/config.toml
~/.local/share/linux-conductor/linux-conductor.db
~/.local/state/linux-conductor/logs/<workspace>/
~/.cache/linux-conductor/
~/conductor/workspaces/<repo>/<workspace>/
```

## Documentation

- [Manual testing checklist](docs/manual-testing-checklist.md)
- [Local deploy and validation guide](docs/deploy-and-local-test.md)
- [Conductor docs parity map](docs/conductor-docs-parity-map.md)
- [Packaging notes](packaging/README.md)

## Known Limits

- Agent chat is transcript-oriented, not a rich structured chat UI yet.
- Terminal rendering handles common ANSI/control redraws, but it is not a full
  terminal emulator.
- GitHub PR workflows use the local `gh` CLI and require `gh auth login`.
- Linear workspace creation requires `LINEAR_API_KEY`.
- Command palette, broad shortcuts, deep links, monorepo directory selection,
  linked directories, theme/view configuration, and unified local history are
  not finished.
- `checkpoint restore` is destructive: it resets the workspace and removes
  untracked files.
- Flatpak is experimental because arbitrary repository access needs broad
  filesystem permissions.

## License

MIT
