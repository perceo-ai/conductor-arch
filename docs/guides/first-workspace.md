# Your first workspace

Goal: a repository registered, an agent working on its own branch, and a merged
pull request. Budget an hour the first time, mostly spent on the repository
settings in step 3 — that is the part that pays off on every workspace after.

## 1. Pick the right artifact

Releases ship two families of artifact with confusingly similar names. Getting
this wrong is the most common first-run problem.

| You want | Artifact | Contains |
| --- | --- | --- |
| The desktop app | `Archductor-<version>-<arch>.AppImage`, `.deb`, `.rpm`, `.dmg`, or the Windows installer | Electron UI **plus** the `archcar` and `archductor` binaries |
| CLI and daemon only | `archductor-<version>-x86_64.AppImage` or `archductor-<version>-linux-x86_64.tar.gz` | `archductor` and `archcar`, no UI |

Capital `A` is the app; lowercase is the command line. The desktop installers
are self-contained — they bundle Chromium, Node, and both sidecars, so the
target machine needs no Archductor-specific runtime libraries. Only `git`,
`gh`, and your agent CLIs have to exist on the host.

`archductor` with no subcommand prints help; it does not open a window. The
GUI is a separate executable that the installers put on your desktop menu.

If you install by hand, **copy `archcar` next to `archductor`**. The CLI
resolves the daemon as a sibling of its own executable before falling back to
`PATH`, so a lone `archductor` in `/usr/local/bin` will fail to start a daemon.

Package-manager installs (`brew`, `paru -S archductor`, `nix run`, `.deb`,
`.rpm`) always place both.

## 2. Make the tools reachable

Archductor shells out to CLIs you have already authenticated. It stores no
credentials and proxies no API calls.

```bash
gh auth login          # required for anything PR-shaped
codex login            # or: claude auth login
archductor doctor      # environment check
archductor setup       # the same readiness probe the app's first-run gate uses
```

`setup` reports per-provider readiness. `--recheck` re-reads the process
environment first, which is what you want right after installing a tool in
another terminal.

Three providers can run as managed chat sessions: **Codex**, **Claude Code**,
and **Gemini CLI** (over the Agent Client Protocol). Aider, Amp, Copilot CLI,
Grok, OpenCode, and Cursor Agent are detected and listed by
`archductor archcar providers`, but this build does not launch them as
sessions. Shell sessions always work.

You do not need any agent CLI to get value out of the tool. Isolated worktrees,
the diff surface, checks, and the PR flow work with Shell sessions alone.

## 3. Register the repository

```bash
archductor repo add ./my-app --name my-app
archductor repo doctor my-app
```

`repo doctor` is worth reading rather than skimming. It tells you whether the
default branch, remote, and worktree parent directory are what you think they
are — all three are baked into every workspace created afterwards.

Then write the settings file. **Do this before creating workspaces**, because
a workspace copies configuration at creation time and it is faster to fix the
file than to recreate three workspaces.

```toml
# .archductor/settings.toml — committed, shared with the team

file_include_globs = """
.env
.env.local
"""

[scripts]
setup = "pnpm install"
run = "pnpm dev --port $ARCHDUCTOR_PORT"
test = "pnpm test"
lint = "pnpm lint"
```

Four things earn their keep immediately:

- **`setup`** runs once per new workspace. A fresh worktree has no
  `node_modules`, no `target/`, no `.venv` — nothing gitignored. Without a
  setup script every new workspace starts broken and you will blame the tool.
- **`file_include_globs`** lists gitignored files to copy from the main
  checkout into each new worktree. This is how `.env` reaches the workspace.
  It only ever copies gitignored files; tracked files come from Git.
- **`$ARCHDUCTOR_PORT`** is a stable per-workspace port. Use it in `run` or
  two workspaces will fight over 3000.
- **`test` and `lint`** become the workspace's checks, runnable from the
  Checks panel and from `archductor archcar run-check`.

The full schema is in [Configuring a repository](repository-settings.md).

## 4. Create the workspace

```bash
archductor workspace create my-app \
  --name fix-auth --branch fix/auth --base main
```

Or, in the app, from a prompt, a GitHub issue, a GitHub PR, or a Linear issue
(`--from-issue`, `--from-pr`, `--from-linear`, `--prompt`). Issue-sourced
workspaces seed the branch name and the first agent message from the issue,
which is worth more than it sounds when you create a dozen a day.

What you get: a Git worktree, a branch, a `.context/` directory for scratch
state, a reserved port range, and copied local files.

The naming rule that matters: **one workspace is one reviewable unit.** If two
changes should land as two pull requests, they need two workspaces. Multiple
chats inside one workspace are fine — they share the branch on purpose.

## 5. Start an agent

```bash
archductor session start fix-auth --kind codex
archductor session send fix-auth --kind codex "Fix the token expiry off-by-one in auth middleware"
```

In the app this is the Chat panel. Either way the message goes into a durable
queue owned by `archcar`, not into a terminal buffer — so it survives the app
restarting, and it is delivered when the agent is ready for it rather than
being typed into the middle of a running turn.

That queue behavior is the thing most worth understanding early; see
[Agent sessions](agent-sessions.md) for queueing versus steering, plan mode,
and permission prompts.

## 6. Review

```bash
archductor diff fix-auth                 # unstaged changes
archductor diff fix-auth --uncommitted   # staged and unstaged, vs HEAD
archductor diff fix-auth --commit <sha>  # one commit
archductor checks fix-auth
```

The daemon-level command inverts that default: `archductor archcar
workspace-diff <ws>` shows *everything against the review base* and takes
`--uncommitted` to narrow to working-tree changes. Use `archcar workspace-diff`
when you want the whole branch, `diff` when you want what you just typed.

In the app the Changes panel is the same data. Review the diff in the app
rather than in your editor when you can: the panel also carries todos, local
review comments, sibling-workspace conflicts, PR checks, and GitHub PR
comments — and any of them can be pushed straight back into the agent's input
queue instead of being copy-pasted.

Sibling conflicts are the underrated one. If another in-flight workspace has
touched the same files, you see it here, before the merge.

## 7. Ship

```bash
archductor archcar push-branch fix-auth      # PR creation needs an upstream
archductor pr create fix-auth --title "Fix auth token expiry" --draft
archductor pr checks fix-auth
archductor pr merge fix-auth --method squash
archductor workspace archive fix-auth --remove-worktree
```

`pr create --from-context` fills the title and body from the workspace's
generated draft — the summary, the tasks, per-agent contributions, check
results, and recorded risks. It is better than a hand-written stub when the
work spanned several sessions.

Merge blockers are enforced by `pr merge`. Two are on by default, which
surprises people the first time:

| Rule | Default |
| --- | --- |
| `block_on_open_todos` | **on** |
| `block_on_open_comments` | **on** |
| `block_on_failed_checks` | off |
| `block_on_pending_checks` | off |

So an unfinished todo will refuse the merge until you close it or turn the rule
off:

```toml
[customization.merge_rules]
block_on_open_todos = false
block_on_failed_checks = true
```

Archiving keeps the record and the transcripts; `--remove-worktree` reclaims
the disk. `archductor workspace restore` brings it back.

## When it goes wrong

Work down this list; it is ordered by how often it is the answer.

| Symptom | Check |
| --- | --- |
| Workspace launch fails immediately | An `env_file_refs` entry points at a file that does not exist. That is a hard failure by design — a missing `.env` should not silently produce a half-working workspace. |
| New workspace has no dependencies | No `[scripts] setup`, or setup failed. `archductor logs <workspace>`. |
| Agent starts and dies | The provider CLI is not on the daemon's `PATH`. `archductor setup`, and `archductor service doctor` if the daemon runs as a service. |
| Two workspaces fight over a port | The `run` script hardcodes a port instead of using `$ARCHDUCTOR_PORT`. |
| PR commands fail | `gh auth status`. Or the branch has no upstream — `archductor archcar push-branch <workspace>`. |
| Everything is stale | `archductor archcar status`, then `archductor archcar ensure`. |

`archductor archcar processes <workspace>` lists every setup, run, check, and
session process the daemon believes it owns, which is the fastest way to find
a process that outlived its session.
