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
archductor status                    # workspaces at a glance: run script, agents, PR
archductor remote status             # which daemon this machine talks to
archductor service status            # is the background service installed and running
archductor archcar providers         # every agent this build knows, and how far it drives each
archductor archcar inventory-snapshot  # repositories, workspaces, and active chats in one request
```

A release build prints one line to stderr when it is behind the latest tag:

```
update available: v0.6.2 → v0.7.0 — https://github.com/perceo-ai/conductor-arch/releases/latest
```

The daemon refreshes that answer every six hours, so the command itself never
touches the network and works offline. `ARCHDUCTOR_NO_UPDATE_NOTICE=1` turns it
off; builds from source never print it, having no release version to compare.

There is no "start the daemon" command, because you never need one: the client
spawns `archcar` itself when it cannot reach a running daemon. Any `archcar`
subcommand therefore doubles as a liveness check — `archductor archcar
inventory-snapshot` is a cheap one. `archductor archcar status` and
`archductor archcar ensure` are **session** commands, not daemon ones; they take
a session id and a workspace respectively.

## Watching the board from a script

Two commands answer "what is every agent doing" without reading a log. Both
are small by default, ASCII only, and have a versioned `--json` form, so a
caller on a slow link (an agent polling through `ssh` or a VM guest agent) can
use one short call per question.

```bash
archductor status                          # one line per workspace
archductor status fix-auth --json          # one JSON document; omit the name for every workspace
archductor chat fix-auth                   # the last 2 turns of the most recent chat
archductor chat fix-auth --tail 5 --no-thinking
archductor chat fix-auth --session 9 --since 2026-09-30T08:00:00Z --json
```

`status` separates the workspace **run script** (`run:stopped`) from the
**agents** (`agent working`, `agents 1 working, 2 finished`). Liveness comes from
the daemon, which holds each agent process; if the daemon cannot be reached the
recorded PID is checked instead and `liveness_source` says `pid`.

An agent's `state` is one of:

| state | meaning |
| --- | --- |
| `working` | alive and mid-turn: thinking, streaming, or running a tool |
| `awaiting_input` | alive and blocked on a person: a permission prompt, a question, a plan to approve, or a fresh chat with no task yet |
| `finished` | the last turn completed successfully (idle, or exited) |
| `failed` | the last turn ended in an error |
| `stopped` | not running, and the last turn did not finish |

`status --json` (`schema_version` 1):

```json
{"schema_version":1,"generated_at":"2026-09-30T09:09:58Z","workspaces":[
  {"workspace":"fix-auth","repository":"my-app","status":"active","branch":"fix/auth",
   "has_upstream":true,"ahead":2,"behind":0,"additions":140,"deletions":8,"open_todos":0,
   "run_script":"stopped","state":"working",
   "pr":{"number":150,"state":"open","url":"https://github.com/o/r/pull/150","checks":"passing"},
   "pr_url":"https://github.com/o/r/pull/150",
   "sessions":[{"session_id":9,"thread_id":12,"kind":"claude","title":"Fix token expiry",
     "alive":true,"liveness_source":"daemon","state":"working",
     "last_activity":"2026-09-30T09:09:59Z","idle_seconds":0,
     "current_tool":"Bash: cargo test --all","turn_outcome":"running","turns":4,
     "pending_interactions":0,"queued_inputs":0,
     "pr_url":"https://github.com/o/r/pull/150"}]}]}
```

Fields that do not apply are left out rather than `null`. `sessions` lists every
live agent plus the three most recent stopped ones (live ones only, for an
archived workspace). `pr_url` is the workspace PR, else the newest PR an agent
opened in its chat (`gh pr create` output), so "is it done, and where is the PR"
needs no log search. `turn_outcome` is `running`, `success`, `failed`,
`interrupted`, or `unknown` (an older turn with no recorded end).

`chat` prints one line per step: `user:` requests, `assistant:` prose, a tool
call as `Bash: cargo test --all` with its result clipped on the next line
(`-> ...`), `ERROR` for failed calls, `PROMPT` for a waiting permission prompt,
and thinking as a one-line marker. Clipped text ends in `...[+N chars]`; a busy
turn shows its request and last `--steps` (10) steps. `--full` turns clipping
off.

`chat --json` is JSON Lines: a `chat` record, then one `turn` record per turn.

```json
{"type":"chat","schema_version":1,"workspace":"fix-auth","thread_id":12,"title":"Fix token expiry","provider":"claude","session":{...same as a status session...},"turns_total":4,"turns_shown":2,"other_threads":[11,10]}
{"type":"turn","turn":4,"started_at":"2026-09-30T09:07:24Z","outcome":"running","elided":3,"entries":[
  {"kind":"user","at":"2026-09-30T09:07:24Z","text":"run the tests","status":"running"},
  {"kind":"tool","tool":"Bash","text":"cargo test --all","status":"complete","result":"test result: ok. 3 passed"},
  {"kind":"error","tool":"Edit","text":"src/auth.rs","status":"failed","result":"File has not been read yet."}],
 "pr_urls":["https://github.com/o/r/pull/150"]}
```

Entry `kind` is `user`, `assistant`, `thinking`, `tool`, `prompt`, `error`, or
`event` (plans, background tasks, notifications). `truncated: true` marks a
clipped entry and `nested: true` a subagent's step. `archductor logs <ws>
--session` remains the raw provider stream.

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
archductor archcar chat-projection <thread-id>          # the timeline the desktop draws, one line per card
archductor archcar chat-projection <thread-id> --full   # every body in full: command output, subagent reports
archductor archcar create-chat fix-auth
archductor archcar close-chat <thread-id>
archductor archcar fork-chat <thread-id> --through-message-id <id>

archductor archcar queue list <thread-id>
archductor archcar queue remove <queue-id>
archductor archcar interactions list --all
archductor archcar interactions allow <id> --always
archductor archcar plan-mode <thread-id> --on
```

`chat-projection` prints each card's title with a one-line preview. Rows a
subagent produced are indented under the Agent card that spawned it, and
backgrounded commands and agents appear as their own cards. Pass `--full` to
print bodies untruncated, for example to read a command's whole output.

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
archductor pr view fix-auth                          # re-reads GitHub: "checks: failing (19/20 passed, 1 failed)"
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
```

`service doctor` answers for **the daemon**, not for your shell — the two differ
in exactly the cases worth diagnosing. It prints the PATH the service unit
recorded, every tool resolved against it, and on macOS a `file access` section:

```
file access:
     ok  /Users/you/Desktop
 DENIED  /Users/you/Documents
  Grant Full Disk Access to the archcar binary, then restart the daemon.
```

A `DENIED` root is macOS refusing the daemon, not a broken repository. Grant
Full Disk Access to
`/Applications/archductor-desktop.app/Contents/Resources/bin/archcar`, then
`launchctl kickstart -k gui/$UID/ai.perceo.archductor.archcar`.

If no daemon is running, the section is labeled *probed by this shell, not the
daemon* — your shell usually has access the daemon lacks, so treat that reading
as unproven. The command never starts a daemon to answer, because a daemon it
started would inherit your shell's access and report the wrong thing.

```bash
archductor remote connect ssh://you@server --label build
archductor remote list
archductor remote use build
archductor remote status
archductor remote import fix-auth --thread-id 12 --clone-into ~/src/my-app
archductor remote update --all --check   # every daemon's version and how it updates
archductor remote update build           # update one daemon in place and restart it
archductor remote disconnect
```

`remote update` works on any saved daemon without switching to it; see
[Running the daemon on a server](remote-daemon.md#updating-daemons) for what it
does per install channel, and `archductor archcar auto-update on` to let a
daemon keep itself current.

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
archductor history show <process-id>          # saved messages; `chat --session <id>` for the whole conversation
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
