# Archductor

A desktop control plane for running coding agents across isolated Git worktree workspaces.

## About

When one codebase has several streams of work in flight, context-switching between branches, stashes, and half-finished agent runs is where time goes to die. Archductor gives each task its own isolated worktree, branch, and running environment, so you can create a workspace, run Codex or Claude Code, review the diff, open or merge a GitHub PR, and archive the workspace — without leaving the app or trampling parallel work.

Inspired by [Conductor](https://conductor.build), Archductor is its own product: a Linux-first desktop app backed by a Rust control plane, built for teams that want committed, file-editable defaults instead of clicking through settings.

## Part of the Perceo stack

Archductor is part of [Perceo](https://perceo.ai), a local-first developer suite. It pairs with:

- [Archfleet](https://github.com/perceo-ai/archfleet)
- [Archivum](https://github.com/perceo-ai/archivum)

Full documentation lives at [docs.perceo.ai](https://docs.perceo.ai).

## Architecture

Archductor is three cooperating pieces:

- **Electron + Solid.js desktop UI** (`desktop/`) — the primary surface. It holds no in-process state and talks to the daemon only over its Unix socket.
- **`archcar` daemon** — the Rust sidecar that owns durable state (SQLite), managed agent sessions, chat input queues, and PTY-backed processes.
- **`archductor` CLI** — the same backend exposed for automation, smoke tests, and fallback workflows.

Linux is the primary manually validated release target. macOS and Windows are
kept as compile/basic-smoke targets where tooling is available; native Windows
is a preview target until its manual package checklist passes.

## Install

### AppImage

```bash
curl -Lo archductor.AppImage \
  https://github.com/perceo-ai/conductor-arch/releases/latest/download/archductor-x86_64.AppImage
chmod +x archductor.AppImage
sudo mv archductor.AppImage /usr/local/bin/archductor
archductor
```

The AppImage runs the `archductor` CLI and forwards its arguments to it.

### Package managers

```bash
# Arch Linux AUR
paru -S archductor

# Nix
nix run github:perceo-ai/conductor-arch#archductor -- doctor

# Homebrew / Linuxbrew
brew tap perceo-ai/tap
brew install archductor
```

Flatpak packaging uses app ID `ai.perceo.Archductor` and remains experimental (🚧) until the sandbox passes Flathub review.

### Build from source

Install Git, GitHub CLI, SQLite, OpenSSH, `pkg-config`, and Rust for your distro (see the per-distro package lists in [`packaging/README.md`](packaging/README.md)), then:

```bash
git clone https://github.com/perceo-ai/conductor-arch
cd conductor-arch
cargo build --workspace --release --locked
./target/release/archductor
```

Or use the `make` targets:

```bash
make build            # dev build of the Rust workspace
make build-release    # release build (--locked)
make check            # fmt + clippy + tests
make cli              # run the CLI in branch-scoped dev mode
make archcar          # run the archcar sidecar in branch-scoped dev mode
```

Branch-scoped dev targets (`make cli`, `make archcar`, `make dev-env`) set separate XDG config/data/state/cache directories per branch, so multiple checkouts can run side by side. Run `make dev-env` to print the active paths.

### Desktop UI

The Electron app is packaged and run separately:

```bash
make desktop-install         # pnpm install
make desktop-dev             # run the UI in dev mode (auto-spawns archcar)
make desktop-package-linux   # build sidecars + Linux installers
```

### Windows preview

Tagged releases build `archductor-<version>-windows-x86_64.zip` with the CLI and archcar sidecar. Install prerequisites with `winget install --id Git.Git --id GitHub.cli`. Source builds use the MSYS2 UCRT64 toolchain and the `x86_64-pc-windows-gnu` target; the CI workflow is the canonical recipe.

## Requirements

| Tool | Required for |
| --- | --- |
| `git` | Worktrees, branches, diffs, commits |
| `gh` | GitHub PR creation, checks, comments, merge (run `gh auth login` first) |
| `openssh` | SSH repository access |
| `codex` | Codex sessions |
| `claude` | Claude Code sessions |
| `cursor` or `code` | Editor launch when configured |

Linear workspace creation requires `LINEAR_API_KEY`. Codex and Claude Code use your existing local CLI authentication.

## Quickstart

```bash
# Register a repository as a project
archductor repo add ./my-app --name my-app
archductor repo doctor my-app

# Create an isolated workspace on its own worktree + branch
archductor workspace create my-app --name fix-auth --branch fix/auth --base main

# Start a coding agent inside the workspace
archductor session start fix-auth --kind codex

# Review the work
archductor diff fix-auth
archductor checks fix-auth

# Open and merge a PR, then archive
archductor pr create fix-auth --title "Fix auth" --draft
archductor pr merge fix-auth --method squash
archductor workspace archive fix-auth --remove-worktree
```

Normal work happens in the desktop app; the CLI mirrors the same backend for automation and debugging. Run `archductor doctor` to check your environment.

## Headless and remote setup

Everything above works without a GUI. The `archcar` daemon owns all state; the desktop app, the CLI, and MCP clients are all just clients of it. So a server with no display can host the daemon and your laptop can drive it.

### On the server

```bash
# Install the CLI and the daemon (tarball, .deb/.rpm, AUR, Nix, or Homebrew —
# every packager ships both `archductor` and `archcar`).

# One command: install the background service, provision the access token,
# and check that the daemon can reach the tools it needs.
#
# Omit --listen when clients will connect over SSH (the recommended path
# below) — SSH needs no open port at all.
archductor service setup --listen 0.0.0.0:7420
```

`service setup` writes a launchd agent (macOS), a systemd user unit (Linux), or a Task Scheduler logon task (Windows), starts it, and prints the token. Manage it afterwards with `archductor service install|uninstall|status|doctor|token`.

Two things it handles that are easy to get wrong by hand:

- **Surviving logout.** systemd stops a user manager when the user's last session ends, so an SSH-installed unit would die the moment you disconnect. Install runs `loginctl enable-linger` for you and tells you if it could not. `archductor service status` reports `boot_persistent`.
- **The daemon's PATH.** launchd gives a job `/usr/bin:/bin:/usr/sbin:/sbin`, and a systemd user unit is barely richer — neither can see Homebrew, a version manager, or `~/.local/bin`. Install probes your login shell and bakes the resulting PATH into the unit. `archductor service doctor` resolves `git`, `gh`, and every agent CLI against *that* PATH, which is the check that catches "the service is running but every session fails".

On macOS a launchd **agent** starts at login, not at boot. On a headless Mac, log in once after a reboot, or install a root-owned LaunchDaemon. Windows logon tasks have the same scope: running while logged off means storing the account password in Task Scheduler, which archductor will not do for you.

### On each client machine

Two transports. **Prefer SSH** unless you have a reason not to:

```bash
# SSH (recommended): encrypted, no open port, no shared secret.
archductor remote connect ssh://you@server

# Token over TCP: only on loopback or a network you already trust.
archductor remote connect server:7420 --token <token>

archductor remote status      # where requests go, and over which transport
archductor remote disconnect  # back to the local daemon
```

The CLI, the desktop app (Settings → Remote daemon), and `archductor mcp serve` all follow the saved profile, so one `remote connect` moves the whole machine. Sessions, terminals, checks, and PR operations then run **on the server**, which is where the agent CLIs and `gh` auth have to be installed.

#### Why SSH is the better default

`ssh://` runs `archductor archcar stdio-proxy` on the far side and pipes the protocol through the SSH connection. That means:

| | SSH | Token over TCP |
| --- | --- | --- |
| Encryption | yes, by sshd | **none** |
| Identity | your SSH key, per user | one shared token for everyone |
| Revoke one user | remove their `authorized_keys` line | impossible — rotating cuts off everybody |
| Open port on the daemon | none | yes |
| Server setup | sshd, which a headless box already runs | `--listen`, plus a firewall you trust |

The server needs no `--listen` at all for SSH; `archductor service install` with no listener is enough. If `archductor` is not on the non-interactive PATH over SSH, give the path explicitly: `ssh://you@server/opt/archductor/bin/archductor`. Host aliases, jump hosts, and per-host keys work because the destination is handed to `ssh` verbatim — so `~/.ssh/config` applies.

> **Security.** The TCP transport is a shared bearer token in cleartext: no TLS, no per-client identity, and rotating the token revokes every client at once. A bare port (`--listen 7420`) binds loopback only; anything else must sit behind a VPN, an SSH tunnel, or a TLS reverse proxy. Use `ssh://` and none of that applies.

`docs/api.md` documents the protocol itself.

## How it works

1. **Add a project.** Register an existing repository path or clone a Git URL. A project wraps one repository and holds its committed settings, scripts, and prompts.
2. **Create a workspace.** From a branch, a prompt, a GitHub issue, a GitHub PR, or a Linear issue. Each workspace gets its own Git worktree, branch, `.context` directory, and stable `ARCHDUCTOR_PORT` range — so multiple workspaces for the same repo run in parallel.
3. **Run agents and scripts.** Start Shell, Codex, or Claude Code sessions inside the workspace, alongside setup/run/stop scripts and an embedded terminal. `archcar` owns the durable input queues and reconciles stale processes.
4. **Review.** Inspect changed files, diffs, todos, local review comments, sibling-workspace conflicts, PR checks, and GitHub PR comments. Stage any of them straight back into the selected agent session.
5. **Ship.** Create, refresh, merge, and archive GitHub PRs through your local `gh` auth. Merge blockers (open todos, unresolved comments, failed or pending checks) are configurable.
6. **Repeat or archive.** Archive the workspace, restore it later, or move on to the next task.

### Workspace layouts

The workspace top bar includes a Layout menu. **Code** preserves the original
chat-centre/right-inspector arrangement; **Wide**, **Review**, and **Watch** are
alternate built-ins. Built-ins are immutable: dragging, moving, hiding, or
restoring a panel while one is active creates one editable `(<name> edited)`
copy, leaving Code available as a recovery baseline.

Panels can move by dragging their tab or through the keyboard-accessible panel
menu. Regions can be resized or collapsed, and hidden panels can be restored
from Layout or the command palette. Preset definitions sync through `archcar`;
the active preset, region sizes, and collapsed regions stay local to each
device. “Set as project default” writes
`customization.view.default_layout_preset` to the repository-committed
`.archductor/settings.toml` while preserving other keys.

The same lifecycle is available from the CLI:

```bash
archductor layout presets --repository my-app
archductor layout show wide
archductor layout set-default wide --repository my-app
archductor layout delete custom-my-layout
```

## Configuration

Shared project settings live at `.archductor/settings.toml` in the repository root; machine-local overrides go in `.archductor/settings.local.toml` (never commit secrets). Settings cover scripts, prompts, prompt-pack metadata, environment, Git behavior, naming, automation, agent profiles, merge rules, workspace defaults, and view preferences. Use `.worktreeinclude` to copy gitignored local files (like `.env`) into new workspaces.

Scripts and agent processes receive Archductor context via environment variables (`ARCHDUCTOR_WORKSPACE_PATH`, `ARCHDUCTOR_ROOT_PATH`, `ARCHDUCTOR_PORT`, and more). See the configuration reference in the repository docs for the full schema and CLI reference.

## Features

**Shipped ✅**

- Add/clone repositories; create workspaces from branch, prompt, GitHub issue, or GitHub PR
- Per-workspace Git worktree, branch, `.context`, and stable port range; parallel workspaces per repo
- Shell, Codex, and Claude Code sessions with transcript persistence and durable, archcar-managed input queues
- Review surfaces: changed files, diffs, todos, local comments, sibling conflicts, PR checks, PR comments
- Stage review comments, failing checks, or PR comments into the active agent session
- Create / refresh / merge / archive GitHub PRs via local `gh`; configurable merge blockers
- Restore archived workspaces; inspect saved Linux session history
- File-editable repository settings (scripts, prompts, environment, Git behavior, merge rules, workspace/view defaults)
- CLI parity with the app backend; export/import of shared and local settings bundles
- Linked workspace directories (symlinked under `.context/linked-directories`)
- Modular workspace layouts with four immutable built-ins, synced custom
  presets, drag/menu movement, hide/restore, region sizing/collapse, and
  per-project defaults

**In progress 🚧**

- Electron UI polish and full visual parity; several historical affordances (force-push, PR review-thread resolve/reopen, richer settings editors, command palette) not yet ported to the desktop app
- Linear-sourced workspace creation in the desktop UI (available via CLI)
- Terminal rendering handles common ANSI/control redraws but is not a full emulator
- Prompt-pack switching / import / export and richer notification controls
- Native Windows: compiles and assembles a portable ZIP, but install/launch/runtime smoke still required before a stable support claim
- Flatpak packaging (needs broad filesystem permissions for arbitrary repo access)

**Planned 📋**

- Explicit product policy for Codex unsafe-approval / sandbox bypass before a broad public launch

## Documentation

- [Current progress and known gaps](progress.md)
- [MVP scope](docs/mvp-scope.md)
- [GUI MVP handoff](docs/conductor-gui-mvp-handoff.md)
- [Manual testing checklist](docs/manual-testing-checklist.md)
- [Local deploy and validation guide](docs/deploy-and-local-test.md)
- [Archductor docs parity map](docs/archductor-docs-parity-map.md)
- [Packaging notes](packaging/README.md)

## License

Apache-2.0
