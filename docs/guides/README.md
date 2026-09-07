# Archductor guides

Task-shaped documentation. The `README.md` at the repository root is the
elevator pitch and the install matrix; these are the pages you read when you
are actually trying to get something done.

| Guide | Read it when |
| --- | --- |
| [Your first workspace](first-workspace.md) | You installed it and want a merged PR by the end of the hour. |
| [Running work in parallel](parallel-workspaces.md) | One workspace works and you want five. |
| [Configuring a repository](repository-settings.md) | New workspaces need setup, ports, secrets, checks, or house rules. |
| [Agent sessions](agent-sessions.md) | You want to drive agents well: queueing, steering, plan mode, background tasks, MCP. |
| [Running the daemon on a server](remote-daemon.md) | The machine that should run the agents is not the machine in front of you. |
| [CLI cookbook](cli.md) | You know what you want and need the command. |

Two conventions used throughout:

- **Workspace** means one Git worktree, one branch, one task. It is the unit of
  everything. When a guide says "the workspace", it means all three at once.
- **archcar** is the Rust daemon that owns state. The desktop app, the CLI, and
  MCP clients are all clients of it and hold no state of their own. When
  behavior differs between the app and the CLI, that is a bug, not a design.

## Reference material, not guides

- [`docs/api.md`](../api.md) — the archcar protocol and MCP surface.
- [`docs/manual-testing-checklist.md`](../manual-testing-checklist.md) — what a
  human exercises before a release tag.
- [`docs/deploy-and-local-test.md`](../deploy-and-local-test.md) — release and
  local verification steps.
- [`packaging/README.md`](../../packaging/README.md) — how the artifacts are built.
- [`progress.md`](../../progress.md) — current state and known gaps. Read this
  before believing any claim in the guides is complete.
