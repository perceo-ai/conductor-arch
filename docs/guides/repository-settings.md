# Configuring a repository

Everything a workspace needs to be useful on creation lives in one committed
file. Getting this right once is worth more than any other configuration work
in the product, because it is the difference between "new workspace is ready"
and "new workspace is a broken checkout I have to fix by hand."

## The three layers

| Layer | Where | Commit it? |
| --- | --- | --- |
| App shared defaults | Application settings, per machine | n/a |
| Repository settings | `.archductor/settings.toml` | **Yes** |
| Local overrides | `.archductor/settings.local.toml` | **No** — gitignore it |

Later layers win key by key. Put team decisions in `settings.toml`, put
absolute paths, personal endpoints, and anything secret in
`settings.local.toml`.

App shared defaults live in `$XDG_CONFIG_HOME/archductor/settings.toml`
(`~/.config/archductor/settings.toml`) and apply to every repository on the
machine. Because the repository layer wins, a key written into
`.archductor/settings.toml` shadows your machine-wide value — so if a global
default appears to be ignored, check whether the repository is setting the same
key.

```bash
archductor archcar settings --repository my-app          # effective merged settings, as JSON
archductor archcar settings-source --repository my-app --layer local
archductor repo settings my-app export --output team.toml
archductor repo settings my-app import team.toml
```

Reading the effective settings rather than the file is the reliable way to
answer "why is this workspace behaving like that" — it is the merged result the
daemon actually uses.

## Scripts

```toml
[scripts]
setup     = "pnpm install --frozen-lockfile"
run       = "pnpm dev --port $ARCHDUCTOR_PORT"
archive   = "./script/workspace-archive.sh"
test      = "pnpm test"
lint      = "pnpm lint"
typecheck = "tsc --noEmit"
build     = "pnpm build"
run_mode  = "concurrent"
```

- **`setup`** runs once when a workspace is created. This is the single most
  important key in the file: a fresh worktree has no gitignored files, so no
  dependencies, no build output, no virtualenv.
- **`run`** is the long-running dev process, started and stopped from the app
  or with `archductor run` / `archductor stop`.
- **`archive`** runs on archive — tear down containers, free a database.
- **`test` / `lint` / `typecheck` / `build`** become the workspace's checks.
  There is no separate checks configuration; these four keys *are* it.
- **`run_mode`** defaults to `concurrent`. Set it to `nonconcurrent` when the
  dev server binds something genuinely global (a fixed database port, a docker
  network) and only one workspace may run at a time. Starting a second run then
  fails with a message naming the workspace already running, instead of
  producing a confusing port collision.

### Several run scripts

When a workspace has more than one thing to start, `run` takes a table instead
of a string:

```toml
[scripts.run.web]
command = "pnpm dev --port $ARCHDUCTOR_PORT"
default = true

[scripts.run.worker]
command = "pnpm worker"
```

### Checks

```bash
archductor archcar check-list <workspace>       # what is configured
archductor archcar run-check <workspace> test   # run one, by key
archductor archcar check-log <workspace>        # latest output
archductor checks <workspace>                   # stored summary
```

Keys are `test`, `lint`, `typecheck`, `build`. Each falls back to
`customization.automation.<name>_command` if the `[scripts]` key is unset, so
either spelling works; prefer `[scripts]`.

The same four commands are also offered in the command palette, so
`[scripts] test` is what makes "Test" appear there.

## Getting local files into a workspace

A new worktree has tracked files only. Two sources of copy patterns, and they
are **combined, not ranked**: `included_file_patterns` concatenates the
`.worktreeinclude` lines with `file_include_globs` and matches gitignored files
against the union.

```
# .worktreeinclude — one pattern per line, in the repository root
.env*
certs/**
```

```toml
# .archductor/settings.toml — added to the above, not overridden by it
file_include_globs = """
.env
config/*.local.json
"""
```

Three things that surprise people:

- **There is no precedence.** A pattern in either source copies files. Removing
  a glob from `settings.toml` does nothing if `.worktreeinclude` still matches.
- **`.env*` is not a runtime fallback.** It is written into the scaffolded
  `settings.toml` when a repository is bootstrapped. With both sources genuinely
  empty, nothing is copied at all.
- **Negation lines are dropped.** `parse_pattern_lines` discards lines starting
  with `!` (and `#`), so gitignore-style negation in `.worktreeinclude` silently
  does nothing. There is no way to exclude a file once a pattern matches it.

> The settings inspector disagrees with the copier. `inspect_repository_settings`
> reports a precedence (`.worktreeinclude` > `file_include_globs` > `.env*`) for
> display, but `copy_included_ignored_files` unions them. Trust the behavior
> described here; the inspector's `active_file_patterns` is a UI label, not what
> runs.

Only gitignored files are copied. Dependencies and build output are
deliberately excluded — reproducing them with `[scripts] setup` is faster and
does not carry stale artifacts between branches.

```toml
env_file_refs = """
.env
"""
```

`env_file_refs` is different from copying: these files are *parsed* and their
variables injected into scripts and agent processes. Every listed file must
exist when a workspace launches, or the launch fails. That is intentional — a
missing `.env` should be a loud error, not an app that boots with empty
configuration. The workspace copy is preferred; the repository root is the
fallback.

## Environment

```toml
[environment_variables]
NODE_ENV = "development"
API_BASE = "http://localhost:8080"
```

Archductor injects these on top of its own variables. Scripts and agent
processes always receive:

| Variable | Value |
| --- | --- |
| `ARCHDUCTOR_WORKSPACE_NAME` | The workspace name |
| `ARCHDUCTOR_WORKSPACE_PATH` | Absolute path to the worktree |
| `ARCHDUCTOR_WORKING_DIRECTORY` | Where scripts actually run (see `working_directory`) |
| `ARCHDUCTOR_ROOT_PATH` | Absolute path to the main repository checkout |
| `ARCHDUCTOR_DEFAULT_BRANCH` | The repository's default branch |
| `ARCHDUCTOR_PORT` | Base of this workspace's reserved port block |
| `ARCHDUCTOR_IS_LOCAL` | Always `1` |

Precedence, lowest to highest: built-ins, then `env_file_refs` contents, then
`[environment_variables]`.

## Prompts and prompt packs

Prompts are the text sent to an agent for each built-in action — creating a
pull request, resolving conflicts, fixing failing tests. They are worth editing
because they encode how *your* repository wants those jobs done.

```toml
[prompt_pack]
active = "team"
path = ".archductor/prompt-packs/team.toml"

[prompts]
create_pr = "Write the PR body in our house format: Summary, Risk, Rollback."
```

A pack is a file under `.archductor/prompt-packs/`; `default.toml` is created
for you on bootstrap. Keys available in both `[prompts]` and a pack file:

`new_workspace`, `general`, `continue_work`, `summarize_session`, `handoff`,
`code_review`, `create_pr`, `fix_errors`, `resolve_merge_conflicts`,
`rename_branch`, `commit_generation`, `push_branch`, `merge_pr`,
`revert_changes`, `review_comments`, `test_fixing`, `refactor_style`,
`setup_script`, `run_script`.

Inline `[prompts]` in `settings.toml` overrides the active pack, so a pack can
carry the house defaults and one repository can deviate on a single key.

```bash
archductor archcar prompt-packs <repository>
archductor archcar set-prompt-pack <repository> team
archductor archcar git-action-prompt <workspace> --action create-pr
```

## Providers

```toml
codex_executable_path = "/opt/homebrew/bin/codex"
claude_code_executable_path = "/opt/bin/claude"
claude_provider = "anthropic"
```

These are top-level keys, not a `[providers]` table. Set them when the CLI is
not on the daemon's `PATH` — which is common when `archcar` runs as a
background service, since a launchd job or systemd user unit gets a much
narrower `PATH` than your shell. `archductor service doctor` resolves the agent
CLIs against the *service's* `PATH` and is the check that catches this.

## Git behavior

```toml
[git]
archive_on_merge = true
```

`archive_on_merge` archives the workspace as part of a successful merge.

## Customization

### Naming and pull requests

```toml
[customization.naming]
workspace_name_style = "city"
default_merge_method = "squash"
pr_title_template = "{type}({workspace}): {summary}"
pr_body_sections = ["Summary", "What Changed", "Risk", "Validation"]
```

Placeholders available in `pr_title_template`: `{workspace}`, `{branch}`,
`{summary}`, `{session_summary}`, `{changed_files}`, `{changed_files_count}`,
`{type}`.

`pr_body_sections` replaces the default headings (Summary, What Changed, Why,
User Impact, Validation). Section content is generated by matching the heading
text, so keep recognisable words in your names.

### Automation

```toml
[customization.automation]
auto_setup = true
test_command = "cargo test --workspace"
```

`auto_setup` runs the setup script automatically on workspace creation.
`test_command`, `lint_command`, `typecheck_command`, and `build_command` are
fallbacks for the `[scripts]` keys of the same name.

### Merge rules

```toml
[customization.merge_rules]
block_on_open_todos = true       # default true
block_on_open_comments = true    # default true
block_on_failed_checks = false   # default false
block_on_pending_checks = false  # default false
```

Enforced by `archductor pr merge`. The first two default to **on**, so an open
todo will refuse a merge until you resolve it or opt out.

### Workspace defaults

```toml
[customization.workspace_defaults]
base_branch = "main"
workspace_parent = "~/worktrees/my-app"
branch_prefix = "pk"          # default "lc"; set it machine-wide instead if you
                              # want every repository to use it
working_directory = "apps/web"
port_block_size = 20          # default 10
default_visible_tab = "changes"
```

`working_directory` is the one to reach for in a monorepo: scripts and agent
sessions start there instead of at the worktree root.

### View

```toml
[customization.view]
default_layout_preset = "review"
```

`default_layout_preset` is the team-level layout default and is what
`archductor layout set-default` writes.

## Keys the schema accepts but does not act on yet

The settings file and the Settings UI accept more keys than the daemon
currently honors. They round-trip cleanly and are safe to write, but writing
them changes nothing today:

| Key | Status |
| --- | --- |
| `enterprise_data_privacy` | Parsed only |
| `[git] delete_branch_on_archive`, `worktree_push_auto_setup_remote`, `branch_prefix`, `branch_prefix_type` | Parsed only; use `customization.workspace_defaults.branch_prefix` for prefixes |
| `[customization.naming] branch_template`, `commit_style` | Parsed only |
| `[customization.automation]` lifecycle hooks — `pre_clone`, `post_clone`, `pre_workspace_create`, `post_workspace_create`, `pre_setup`, `post_setup`, `pre_pr_create`, `post_pr_create`, `pre_merge`, `post_merge`, `pre_archive`, `post_archive` | Parsed only. Nothing runs them. |
| `[customization.automation] auto_start_agent`, `required_local_files` | Parsed only |
| `[customization.merge_rules] definition_of_done` | Parsed only |
| `[customization.workspace_defaults] auto_open`, `checkpoint_timing` | Parsed only |
| `[customization.view] theme`, `accent_color`, `colors`, `density`, `keybindings`, `terminal_font`, `terminal_scrollback`, `command_palette_presets`, `notification_rules` | Core surfaces these as repository view defaults, but the Electron app reads its own per-machine preferences instead. Change them in Settings. |
| `[customization.view] sidebar_layout`, `diff_preference`, `transcript_display`, `dashboard_columns`, `settings_import_export` | Parsed only |
| `[customization.agent_profiles]` | Profile names are surfaced; the profiles do not yet drive session launches |

If one of these matters to you, that is useful signal — open an issue rather
than working around it.

## Spotlight testing

```toml
spotlight_testing = false
```

Off by default. When enabled, `spotlight-start` applies one workspace's tracked
changes onto the main repository checkout so you can exercise them in an
environment that only exists there — a simulator, a docker stack, a seeded
database. `spotlight-stop` reverts. It requires a clean root working tree, and
one repository has at most one active spotlight session at a time.

## A working example

```toml
# .archductor/settings.toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

file_include_globs = """
.env
.env.local
"""

env_file_refs = """
.env
"""

[scripts]
setup     = "pnpm install --frozen-lockfile"
run       = "pnpm dev --port $ARCHDUCTOR_PORT"
test      = "pnpm test"
lint      = "pnpm lint"
typecheck = "tsc --noEmit"

[environment_variables]
NODE_ENV = "development"

[git]
archive_on_merge = true

[customization.naming]
default_merge_method = "squash"
pr_body_sections = ["Summary", "What Changed", "Risk", "Validation"]

[customization.merge_rules]
block_on_failed_checks = true

[customization.workspace_defaults]
base_branch = "main"
port_block_size = 20

[customization.view]
default_layout_preset = "code"
```
