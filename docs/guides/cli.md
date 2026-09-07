# CLI cookbook

The CLI is not a lesser surface. It talks to the same daemon as the desktop
app, so anything it does is real product behavior, not a debug path. Use it for
automation, for scripting a repetitive setup, and for finding out what the app
is actually doing when something looks wrong.

## Two command families

```
archductor <verb> ...           # product commands: repo, workspace, session, pr, ...
archductor archcar <verb> ...   # direct daemon RPCs
```

The `archcar` namespace is the raw protocol surface. It has far more commands
and reaches things the product verbs do not expose yet. When a guide reaches
for `archductor archcar something`, that is why.

Both follow the saved remote profile, so every command here works against a
server-hosted daemon unchanged.

## Environment

```bash
archductor doctor                    # environment check
archductor setup                     # provider readiness; --recheck to re-read the environment
archductor status                    # workspaces at a glance (reads the database directly)
archductor remote status             # which daemon this machine talks to
archductor service status            # is the background service installed and running
archductor archcar providers         # every agent this build knows, and how far it drives each
archductor archcar inventory-snapshot  # repositories, workspaces, and active chats in one request
```

There is no "start the daemon" command, because you never need one: the client
spawns `archcar` itself when it cannot reach a running daemon. Any `archcar`
subcommand therefore doubles as a liveness check — `archductor archcar
inventory-snapshot` is a cheap one. `archductor archcar status` and
`archductor archcar ensure` are **session** commands, not daemon ones; they take
a session id and a workspace respectively.

## Repositories

```bash
archductor repo add ./my-app --name my-app --default-branch main
archductor repo list
archductor repo doctor my-app
archductor repo update my-app
archductor repo settings my-app export --output team.toml
archductor repo settings my-app export --local --output my-overrides.toml
archductor repo settings my-app import team.toml

archductor settings export --output app-settings.toml   # app-level, not repository
archductor settings import app-settings.toml
```

Against a remote daemon use `archductor archcar add-repository <path>` instead —
paths resolve on the daemon's filesystem.

## Workspaces

```bash
archductor workspace create my-app --name fix-auth --branch fix/auth --base main
archductor workspace create my-app --from-issue 431
archductor workspace create my-app --from-pr 512
archductor workspace create my-app --from-linear PER-88      # needs LINEAR_API_KEY
archductor workspace create my-app --prompt "Add rate limiting to the public API"

archductor workspace list --active
archductor workspace rename fix-auth auth-expiry
archductor workspace duplicate fix-auth fix-auth-alt --branch fix/auth-alt
archductor workspace archive fix-auth --remove-worktree
archductor workspace restore fix-auth
archductor workspace discard fix-auth                       # throw away the changes
archductor workspace delete fix-auth --remove-worktree --delete-branch
archductor workspace timeline fix-auth --kind pr

archductor workspace branch fix-auth create feature/x
archductor workspace branch fix-auth checkout feature/x
archductor workspace branch fix-auth rename feature/y
archductor workspace branch fix-auth delete feature/x

archductor workspace link-dir frontend backend-api
archductor workspace linked-dirs frontend
archductor workspace unlink-dir frontend backend-api
```

## Sessions

```bash
archductor session start fix-auth --kind codex --model gpt-5 --plan-mode
archductor session list fix-auth
archductor session send fix-auth --kind codex "Add a regression test"
archductor session send fix-auth --immediate "wrong file, stop"
archductor session attach fix-auth --print-pty-path
archductor session open fix-auth --kind claude --print-command
archductor session stop fix-auth

archductor archcar chat-threads fix-auth
archductor archcar chat-transcript <thread-id>
archductor archcar create-chat fix-auth
archductor archcar close-chat <thread-id>
archductor archcar fork-chat <thread-id> --through-message-id <id>

archductor archcar queue list <thread-id>
archductor archcar queue remove <queue-id>
archductor archcar interactions list --all
archductor archcar interactions allow <id> --always
archductor archcar plan-mode <thread-id> --on
```

## Running and checking

```bash
archductor run fix-auth               # the configured run script
archductor stop fix-auth
archductor logs fix-auth --run
archductor runs fix-auth
archductor archcar processes fix-auth # every process the daemon believes it owns

archductor archcar check-list fix-auth
archductor archcar run-check fix-auth test
archductor archcar check-log fix-auth
archductor checks fix-auth
```

## Reviewing

```bash
archductor diff fix-auth                        # unstaged
archductor diff fix-auth --uncommitted          # staged and unstaged, vs HEAD
archductor diff fix-auth --file src/auth.rs
archductor diff fix-auth --name-only
archductor archcar workspace-diff fix-auth      # everything vs the review base
archductor archcar workspace-changes fix-auth --all

archductor conflicts fix-auth                   # sibling workspaces touching the same files
archductor archcar commits fix-auth
archductor archcar commit-diff fix-auth <sha>
archductor archcar commit-draft fix-auth        # suggested commit message
archductor archcar commit fix-auth "fix: token expiry" --stage-all

archductor review add fix-auth src/auth.rs --line 42 needs a test
archductor review list fix-auth
archductor review resolve <id>

archductor todo add fix-auth "handle the 401 path"
archductor todo list fix-auth
archductor todo done <id>
archductor todo sync fix-auth                   # pull todos out of the agent's own list

archductor checkpoint create fix-auth "before the refactor"
archductor checkpoint list fix-auth
archductor checkpoint compare fix-auth <id>
archductor checkpoint restore fix-auth <id>
```

## Pull requests

```bash
archductor archcar push-branch fix-auth              # --force after a rebase (push with lease)
archductor pr create fix-auth --title "Fix auth" --draft
archductor pr create fix-auth --from-context         # title and body from the generated draft
archductor pr view fix-auth
archductor pr checks fix-auth
archductor pr summary fix-auth --agent-prompt
archductor pr resolve-thread fix-auth <thread-id>
archductor pr reopen-thread fix-auth <thread-id>
archductor pr merge fix-auth --method squash

archductor archcar pr-draft fix-auth
archductor archcar pr-readiness fix-auth
archductor archcar workflow-runs fix-auth            # GitHub Actions runs for the branch
```

## Layouts

```bash
archductor layout presets --repository my-app
archductor layout show wide
archductor layout set-default review --repository my-app
archductor layout delete custom-my-layout
```

## Service and remote

```bash
archductor service setup --listen 0.0.0.0:7420
archductor service install
archductor service status
archductor service doctor
archductor service token --rotate
archductor service uninstall

archductor remote connect ssh://you@server --label build
archductor remote list
archductor remote use build
archductor remote status
archductor remote import fix-auth --thread-id 12 --clone-into ~/src/my-app
archductor remote disconnect
```

## MCP and skills

```bash
archductor mcp serve --profile session
archductor mcp register --client claude
archductor mcp unregister
archductor mcp status fix-auth
archductor mcp setup

archductor archcar skills
archductor archcar skill-catalog
archductor archcar install-skill <name>
archductor archcar sync-plan
archductor archcar sync
```

## History and import

```bash
archductor history list --workspace fix-auth
archductor history show <process-id>
archductor import conductor --source <path>   # migrate from a Conductor setup
archductor open fix-auth --editor cursor      # open in an editor
```

## Scripting notes

- Most `archcar` commands print JSON-shaped responses, so `jq` works. The
  product verbs print human text.
- Exit codes are meaningful. `service setup` in particular exits non-zero when
  the daemon did not come up, so provisioning scripts can trust it.
- Set `ARCHDUCTOR_ARCHCAR_REMOTE` and `ARCHDUCTOR_ARCHCAR_TOKEN` in a CI job to
  target a daemon without writing a profile to disk. Environment wins over the
  saved profile.
- `archductor archcar stdio-proxy` is what an `ssh://` client runs on the far
  side. It is not something to invoke by hand.
