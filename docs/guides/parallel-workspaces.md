# Running work in parallel

The whole product exists for this case. One workspace is a nicer terminal;
five at once is the reason to install anything.

## Why worktrees instead of branches

Switching branches in one checkout mutates shared state: the working tree, the
index, `node_modules`, the dev server, the agent's idea of what it just wrote.
An agent that is mid-turn when you switch branches produces garbage, and you
find out at review time.

A Git worktree gives each branch its own directory backed by the same object
store. No stashing, no rebuilding when you switch, and an agent can keep
running in one workspace while you review another. The cost is disk and one
dependency install per workspace, which is what `[scripts] setup` is for.

## The four things that collide

Parallel workspaces break in exactly four ways. All four have a fix.

### 1. Ports

Every workspace gets a reserved block of ports. Allocation starts at **42000**,
hands out **10 ports per workspace** by default, skips blocks already claimed
by another workspace, and skips blocks where the ports are actually in use.
`$ARCHDUCTOR_PORT` is the base of the block.

```toml
[scripts]
run = "pnpm dev --port $ARCHDUCTOR_PORT"

[customization.workspace_defaults]
port_block_size = 20   # if one workspace runs app + api + db + worker
```

Derive the rest of your services from the base rather than hardcoding:

```bash
API_PORT=$((ARCHDUCTOR_PORT + 1))
DB_PORT=$((ARCHDUCTOR_PORT + 2))
```

If two workspaces fight over a port, the `run` script hardcoded one. There is
no other cause.

### 2. Gitignored local files

A new worktree contains tracked files only. Your `.env`, your local config,
your certificates — none of it is there.

Two sources of copy patterns, and they are **combined, not ranked** — the
patterns from both are concatenated and matched against the repository's
gitignored files:

| Source | Behavior |
| --- | --- |
| `.worktreeinclude` in the repository root | Its lines are added to the pattern list |
| `file_include_globs` in `.archductor/settings.toml` | Its globs are added too — having a `.worktreeinclude` does not disable it |
| Neither configured | Nothing is copied. `.env*` is scaffolded into a new `settings.toml`, but it is not a runtime fallback |

Lines starting with `!` or `#` in `.worktreeinclude` are discarded, so
gitignore-style negation does not work — once a pattern matches, the file is
copied.

Only gitignored files are ever copied. Build output and dependency directories
are not — reproduce those with `[scripts] setup`, which is both faster and
correct.

If a workspace genuinely cannot start without a file, list it in
`env_file_refs`. That turns a missing file into a launch failure with a clear
message instead of an application that boots with empty configuration.

### 3. Two agents editing the same file

Nothing stops it, and nothing should — sometimes it is what you want. What the
tool does is tell you before you merge.

The Changes panel shows **sibling conflicts**: other in-flight workspaces that
have touched files you also touched.

```bash
archductor conflicts <workspace>
```

Check this before opening the PR, not after CI turns red. When two workspaces
do overlap, the usual fix is to merge the smaller one first and rebase the
other, not to try to coordinate the two agents.

There is a lighter-weight version of the same signal inside one workspace:
declare what a session is meant to touch and get an advisory warning when two
sessions overlap.

```bash
archductor archcar session-areas <workspace> <session-id> --area src/auth
archductor archcar overlaps <workspace>
```

### 4. You

The binding constraint on parallel agent work is review capacity, not machine
capacity. Four workspaces producing diffs faster than you can read them is
worse than two, because unreviewed agent output accumulates into a merge
problem you cannot delegate.

Practical ceiling for one person: roughly as many workspaces as you can hold
the intent of at once. That is usually three to five.

## Moving between workspaces

Keyboard, in the app. These are the ones worth learning:

| Keys | Action |
| --- | --- |
| `mod+1` … `mod+9` | Jump to workspace 1–9 |
| `mod+alt+↑` / `mod+alt+↓` | Previous / next workspace |
| `mod+k` | Command palette |
| `mod+n` | New workspace |
| `mod+l` | Focus the chat input |
| `mod+enter` | Send immediately (steer the running turn) |
| `mod+shift+d` | Changes / diff |
| `mod+shift+p` | Create or refresh the pull request |
| `mod+j` | Toggle the terminal panel |
| `mod+/` | Full shortcut list |

`mod` is Cmd on macOS, Ctrl elsewhere.

Rebind them in **Settings → Shortcuts** in the app. Overrides are stored
per-machine in the renderer's local preferences, not in
`.archductor/settings.toml` — a keymap is a personal choice and should not
travel with the repository. The override format is `action = chord`, one entry
per line or separated by `;` or `,`:

```
palette = mod+shift+k
terminal = mod+`
```

Every chord must include a modifier. Assigning a chord that another action
already holds clears the old binding rather than leaving the keymap ambiguous.

`customization.view.keybindings` exists in the settings schema and core surfaces
it as a repository view default, but the Electron app does not read it yet;
Settings is the working path today.

## Layouts

Four built-in layouts, because "review three diffs" and "watch a long agent
run" want different screens.

| Preset | Shape | Use it for |
| --- | --- | --- |
| **Code** | Chat centre, inspector right (Summary / Files / Changes / Checks), PR strip, terminal dock | Default. Driving one agent. |
| **Wide** | Files left, chat centre, inspector right, terminal along the bottom | Wide monitors; keeping the file tree visible. |
| **Review** | Files left, **Changes** centre, chat demoted into the right stack | Reading a finished diff. Chat is still there, just not the focus. |
| **Watch** | Terminal centre, chat bottom, Summary + Checks right | Long-running agent work or a flaky test loop. |

Built-ins are immutable. Dragging, hiding, or resizing a panel while one is
active forks it once into `<name> edited`, so `Code` always survives as a
recovery baseline. Preset definitions sync through `archcar`; which preset is
active and how wide your regions are stay local to the device — the same
layout should not follow you onto a laptop with a different screen.

```bash
archductor layout presets --repository my-app
archductor layout show wide
archductor layout set-default review --repository my-app   # writes settings.toml
archductor layout delete custom-my-layout
```

`set-default` writes `customization.view.default_layout_preset` into the
committed `.archductor/settings.toml`, preserving the other keys. It is a team
decision, so it belongs in the committed file.

## Splitting and joining work

**Fork a chat** when an agent's conversation is worth branching — you want to
try a second approach from message 40 without losing the first.

```bash
# Second chat, same workspace and branch:
archductor archcar fork-chat <thread-id> --through-message-id <id>

# Second chat in a new workspace, branched off the source branch:
archductor archcar fork-chat <thread-id> --through-message-id <id> \
  --new-workspace --workspace-name try-b --workspace-branch try/b
```

The fork carries the conversation up to that point, so the new agent starts
with the context instead of a summary of it. In the app this is on a message's
menu.

**Link workspaces** when one needs to read another's checkout — a frontend
workspace that needs the backend branch that is still in flight. The target
workspace is symlinked into `.context/linked-directories/<target>`.

```bash
archductor workspace link-dir frontend backend-api
archductor workspace linked-dirs frontend
```

Both workspaces must be active. This is a read path for agents and build
tooling; it is not a substitute for multi-repo projects, which the product
model does not have (one project wraps one repository).

**Duplicate a workspace** when you want the same starting point twice:

```bash
archductor workspace duplicate fix-auth fix-auth-alt --branch fix/auth-alt
```

## Testing the change in your real environment

Some setups only exist in the main checkout — a simulator, a docker-compose
stack, a seeded database. Spotlight testing applies one workspace's tracked
changes onto the root checkout so you can exercise them there, and reverts
cleanly afterwards.

```toml
spotlight_testing = true
```

```bash
archductor archcar spotlight-start <workspace>
archductor archcar spotlight-status <workspace>
archductor archcar spotlight-stop <workspace>
```

It requires a clean root working tree and refuses if the workspace has no
tracked changes. One repository has at most one active spotlight session;
starting a second stops the first. A checkpoint is taken before the patch is
applied.

## Workspace names

When you do not name a workspace, it gets a city name (`madrid`, `lisbon`, …)
picked from the ones not currently in use, rather than `workspace-3`. Names are
how you find things a week later, so this matters more than it looks.

```toml
[customization.naming]
workspace_name_style = "city"   # any other value falls back to workspace, workspace-1, …

[customization.workspace_defaults]
branch_prefix = "pk"            # default "lc"; issue workspaces become pk/gh-issue-431
```

Explicit `--name` and `--branch` always win over both.
