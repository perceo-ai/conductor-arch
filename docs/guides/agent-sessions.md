# Agent sessions

What separates a good session from a frustrating one is mostly knowing how
input reaches the agent and when the agent is allowed to act. That is this
page.

## The object model

- A **session** is one agent process inside a workspace.
- A **chat thread** is the durable conversation. Threads outlive processes: kill
  the session, restart the app, reconnect from another machine — the thread and
  its transcript are still there, because `archcar` owns them, not the UI.
- A **turn** is everything the agent does between one of your messages and the
  next. One tool call is not a turn.

Several sessions in one workspace is normal and share the branch on purpose.
Several workspaces is how you keep work independently reviewable. Do not reach
for a second workspace when what you want is a second chat.

## Which agents actually run

| Provider | Managed session | Notes |
| --- | --- | --- |
| Codex | Yes | Default for `session send` |
| Claude Code | Yes | |
| Gemini CLI | Yes | Driven over the Agent Client Protocol |
| Shell | Yes | No agent, just a PTY in the workspace |
| Aider, Amp, Copilot CLI, Cursor Agent, Grok, OpenCode | Detected only | Listed by `archcar providers`, not launchable as sessions in this build |
| Cursor, VS Code | Editor launch only | |

```bash
archductor archcar providers   # what this build knows, and how completely
archductor setup               # what is installed and authenticated here
```

## Starting a session

```bash
archductor session start fix-auth --kind codex
archductor session start fix-auth --kind claude --model opus --plan-mode
archductor session list fix-auth
archductor session stop fix-auth
```

Options at launch: `--model`, `--plan-mode`, `--fast-mode`, `--approval-mode`,
`--reasoning-mode`, `--effort-mode`, and for Codex `--codex-personality`,
`--codex-goals`, `--codex-skills`. They are passed through to the harness, so
the accepted values are the provider's, not Archductor's.

`session open` prints or runs the equivalent command for an external terminal
instead of a managed session — useful when you want the agent's own TUI.

## Queueing versus steering

This is the part worth internalising.

Messages go into a **durable input queue** owned by the daemon. They are not
typed into a terminal. Consequences:

- A message survives the app closing, the daemon restarting, and you switching
  machines.
- It is delivered when the agent is ready for it, not into the middle of a
  running turn — so you can queue three follow-ups while the agent works and
  they arrive in order, each as its own turn.

```bash
archductor session send fix-auth --kind codex "Also add a regression test"
archductor archcar queue list <thread-id>
archductor archcar queue remove <queue-id>
```

**Steering** is the opposite: deliver now, into the turn in flight.

```bash
archductor session send fix-auth --immediate "stop, you're editing the wrong file"
```

In the app that is `mod+enter`. Use it to redirect an agent that has gone the
wrong way; use the normal queue for everything else. Interrupting a good turn
to add a nice-to-have wastes the turn.

`archductor archcar interrupt <session-id>` stops the turn without sending
anything.

Input kinds — `user`, `review-prompt`, `control-command`, `raw-terminal` —
control how the input is framed. You rarely set them by hand; the app uses them
when staging a review comment or a failing check into a session, which is the
feature that replaces copy-pasting diffs into chat.

## Permission prompts

When an agent asks to do something that needs approval, the request becomes an
interaction the daemon holds. It does not block on a TUI you have to be looking
at.

```bash
archductor archcar interactions list --all --detail
archductor archcar interactions show <interaction-id>
archductor archcar interactions allow <interaction-id> --always
archductor archcar interactions deny <interaction-id> --message "use the existing helper"
archductor archcar interactions answer <interaction-id> --answers-json '{"choice":"b"}'
```

`--always` records the approval so the same request is not asked again.
`deny --message` is the useful form: the message reaches the agent, so it can
choose a different approach rather than just failing.

## Plan mode

Plan mode puts a chat into research-and-propose instead of build. You get a
plan to read before any file is written.

```bash
archductor archcar plan-mode <thread-id> --on
archductor archcar plan <thread-id>          # the plan it is working from
archductor archcar plan-mode <thread-id> --off
```

In the app: `mod+shift+tab` to toggle, `mod+shift+enter` to approve. Worth using
by default for anything touching more than a couple of files — reading a plan
is much cheaper than reading a diff you then have to reject.

Plans the agent saves are listed by `archductor archcar context-plans
<workspace>` and live under the workspace's `.context/plans/`.

## Mid-session controls

```bash
archductor archcar model <session-id> <model>
archductor archcar effort <session-id> <level>
archductor archcar fast <session-id>          # --off to disable
archductor archcar permission-mode <session-id> <mode>
archductor archcar interrupt <session-id>
archductor archcar kill <session-id>
archductor archcar screen <session-id>        # current PTY screen
archductor archcar messages <thread-id>      # a thread id, not a session id
```

Switching model mid-thread is the common one: start cheap, escalate when the
agent is clearly out of its depth, without losing the conversation.

## Keeping track of who did what

With several sessions in one workspace, "which agent wrote this" stops being
obvious. The daemon tracks it.

```bash
archductor archcar contributions <workspace>          # per-session touched files
archductor archcar session-runs <workspace> <id>      # commands and checks that session ran
archductor archcar snapshot-contribution <workspace> <id> \
  --risk "migration is not reversible"
archductor archcar diff-contributions <workspace>
```

A snapshot writes a durable patch under
`.context/archductor/contributions/`, records the commands the daemon ran, and
keeps any risks or blockers you attach. Those risks then appear in the
generated PR body, which is the point — the person reviewing should not have to
excavate them from chat.

Tasks and summaries are the same idea at workspace scale:

```bash
archductor archcar tasks <workspace>
archductor archcar create-task <workspace> "Migrate the session table"
archductor archcar update-task <workspace> <task-id> --status blocked \
  --review-notes "waiting on schema review"
archductor archcar draft-summary <workspace>          # do not store
archductor archcar refresh-summary <workspace> --scope-type workspace
archductor archcar context-briefing <workspace>
```

`context-briefing` is the one to hand a fresh agent that is picking up someone
else's workspace.

## Background tasks

Fire-and-forget: create the workspace, run the agent, run the checks, write the
summary, optionally open the PR — without you watching.

```bash
archductor archcar start-background-task my-app \
  "Upgrade the http client to hyper 1.x and fix the fallout" \
  --provider codex --open-pr

archductor archcar background-tasks --active-only
archductor archcar background-task <id>
archductor archcar cancel-background-task <id>
archductor archcar tick-background-tasks     # advance now instead of waiting
```

A supervisor thread ticks every 10 seconds and moves the task through
`pending → running → checking → summarizing → opening_pr → ready`, or to
`failed` / `cancelled`. Liveness comes from real session state, not from
guessing at terminal output. The desktop shows an OS notification on
`ready` and `failed`.

`--agent provider[=prompt]` (repeatable) runs additional agents in the same
workspace, each with its own session and optionally its own prompt. All of them
link to the workspace task, so per-agent provenance still works.

Constraints worth knowing before you rely on it:

- **Codex and Claude only.** A shell has no idle signal, so there is nothing to
  advance the task on.
- `--no-checks` skips the repository's configured checks.
- `--open-pr` opens a draft; add `--ready-pr` for a ready-for-review PR.

## MCP

Archductor is an MCP server, so an agent can query and drive Archductor itself.

```bash
archductor mcp serve                      # full surface, 31 tools
archductor mcp serve --read-only          # mutating tools hidden
archductor mcp serve --profile session    # the six context tools
archductor mcp register                   # register with claude and codex on this machine
archductor mcp unregister --client codex
archductor mcp status <workspace>
```

Two profiles, for two different jobs:

- **`full`** — an external client driving Archductor: workspaces, tasks,
  sessions, prompts, summaries, context, changes and diffs, checks, review
  status, PR draft and create, background tasks.
- **`session`** — what an agent needs to keep *its own* workspace context
  current, and nothing else: `set_workspace_context`, `get_context_briefing`,
  `get_summary`, `list_tasks`, `create_task`, `update_task`. This is the right
  default for `mcp register`, because an agent that can archive its own
  workspace is a hazard, not a feature.

Because the tools are archcar requests, an MCP client can drive a *remote*
daemon by pointing it at one — see
[Running the daemon on a server](remote-daemon.md).

The server deliberately exposes no presentation state. Layouts, panel
positions, and theme are not MCP tools.

## Skills and MCP servers across agents

Different agents keep skills and MCP servers in different places, so installing
something in one does not give it to the others. `sync` fixes that with a union:
whatever any provider has, every selected provider gets.

```bash
archductor archcar skills           # what is installed here
archductor archcar skill-catalog    # what is installable
archductor archcar install-skill <name>
archductor archcar sync-plan        # exactly what would be written
archductor archcar sync             # write it
```

It only ever adds and overwrites; nothing is deleted, and any file it replaces
is copied to `<name>.archductor-backup` first. Run `sync-plan` before `sync` —
the preview is the whole point of them being separate commands.

## Known rough edges

- Terminal rendering handles common ANSI and control redraws but is not a full
  terminal emulator. Programs that assume one may render wrong.
- PR review-thread resolve and reopen are CLI-only
  (`archductor pr resolve-thread`, `archductor pr reopen-thread`).
- There is no product policy yet for Codex unsafe-approval / sandbox bypass.
  Treat approval modes as something you set deliberately, per session.
