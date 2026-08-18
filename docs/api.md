# Archductor External API

Archductor is API-first for product primitives, not for pixels. The daemon
(`archcar`) owns every workflow object; the desktop app, the CLI, MCP clients,
and remote tools are all clients of the same surface. This document is the
stable description of that surface.

There is deliberately no separate HTTP server. The external API is the archcar
RPC protocol (local socket or token-guarded TCP) plus the MCP server that maps
onto it. Adding a parallel HTTP layer would duplicate the protocol without
adding a capability; revisit only if a browser-only client becomes a product
goal.

## Transports

| Transport | How | Auth |
|-----------|-----|------|
| Local socket | `$XDG_STATE_HOME/archductor/archcar.sock` (platform-specific; loopback TCP on Windows) | filesystem permissions |
| Remote TCP | daemon started with `ARCHDUCTOR_ARCHCAR_LISTEN=host:port` (bare port = loopback) | shared token, sent as the first line of every connection |
| MCP (stdio) | `archductor mcp serve` (optionally `--read-only`) | inherits the archcar transport it points at |

Remote clients resolve their connection in this order: the
`ARCHDUCTOR_ARCHCAR_REMOTE`/`ARCHDUCTOR_ARCHCAR_TOKEN` environment, then the
saved remote profile (`$XDG_STATE_HOME/archductor/remote.json`, owner-only),
then the local daemon. The profile is shared by the CLI and the desktop app,
so one `archductor remote connect` moves every client on the machine.
Token-only security: no TLS, no per-client identity; expose non-loopback
listeners only behind infrastructure you trust. `archductor service token
--rotate` (RPC `rotate_remote_token`) is the revocation story.

## Server-hosted execution

The daemon is the product primitive owner, so hosting Archductor on a server
is a deployment choice, not a different architecture:

1. On the server: install the CLI, then
   `archductor service install --listen 0.0.0.0:7420`. This writes a
   launchd/systemd user unit with `ARCHDUCTOR_ARCHCAR_LISTEN` set, provisions
   the token, and starts archcar. `archductor service token` prints the token.
   Repositories and worktrees live on the server; add them there
   (`archductor repo add …` over the same remote connection works too).
2. On each client machine: `archductor remote connect <server>:7420 --token
   <token>` verifies the daemon responds and saves the profile. From then on
   the CLI, the desktop app (Settings → Remote daemon shows/edits the same
   connection), and `archductor mcp serve` all drive the server-hosted daemon.
   `archductor remote status` shows where requests go; `archductor remote
   disconnect` returns to the local daemon.
3. Sessions, terminals, checks, background tasks, and PR operations execute on
   the server (agent CLIs and `gh` auth must be installed there). The desktop
   app never spawns a local sidecar while a remote is configured.

Wrap the listener in a trusted network layer (VPN, SSH tunnel, or reverse
proxy with TLS) before leaving loopback; the token is the only application-
level credential.

## Protocol shape

Requests and responses are single-line JSON envelopes:

```json
{"id": "1", "payload": {"type": "list_tasks", "workspace": "berlin"}}
{"id": "1", "payload": {"type": "tasks", "workspace": "berlin", "tasks": [...]}}
```

`payload.type` is `snake_case` of the Rust enum variant. The authoritative
schema is `crates/core/src/archcar/protocol.rs` (`ArchcarRequest`,
`ArchcarResponse`, `ArchcarEvent`), mirrored for TypeScript clients in
`desktop/src/bridge/protocol.ts`. A `subscribe` request upgrades the
connection to a stream of `ArchcarEvent` envelopes (session lifecycle, queue
updates, provider interactions, background-task updates).

Errors are always `{"type": "error", "message": "..."}` — never a dropped
connection for a well-formed request.

## Workflow objects

Near-parity across RPC, CLI (`archductor archcar <cmd>`), and MCP tools:

- Repositories and workspaces: add/clone, create (branch, prompt, GitHub
  issue/PR, Linear), lifecycle (archive/restore/rename/duplicate/delete),
  branches, linked directories.
- Agent sessions: chat threads (with first-class `model`), spawn/ensure
  session, prompt queue, immediate delivery, interrupts, provider
  interactions, per-session run history (`list_session_runs`).
- Tasks: CRUD with status, human `owner`, `owner_session_id`, linked
  sessions, intended areas, blocked reason, review notes.
- Summaries: workspace/session/task/review/handoff scopes, drafting.
- Context briefing: `get_context_briefing` returns the current workspace,
  current-chat, task, and next-action context for AI clients without exposing
  UI state.
- Summary maintenance: `refresh_summary` updates workspace/session/task
  summaries from local evidence and is used by the desktop Summary tab plus
  MCP clients; changed summaries broadcast `summary_updated` events.
- Chat task sync: `sync_chat_tasks` creates native workspace tasks from clear
  action items in chat and deduplicates by normalized title.
- Context attachments: branch-local notes/files/pins (`archivum` source is
  reserved for the future integration).
- Diffs and provenance: branch diff, per-session contributions,
  `snapshot_diff_contribution` / `list_diff_contributions` (durable patch +
  risks/blockers), checkpoints incl. `compare_checkpoint`.
- Checks and review: configured check list/run/logs, review comments, PR
  draft/create/refresh/merge, readiness detail.
- Background tasks: `start_background_task` (one or more managed agents via
  `extra_agents`), list/get/cancel/tick; progress is broadcast as
  `background_task_updated` events.
- Service management: install/uninstall/status, remote access status, token
  rotation.

UI-only state (panel splits, selected tabs, scroll positions, visual filters)
has no API on purpose.

## MCP server

`archductor mcp serve` speaks MCP (2025-06-18) over stdio and maps tools onto
archcar requests one-to-one, so an MCP client can drive a local or remote
daemon. `--read-only` hides every mutating tool. Tool names and schemas live
in `crates/core/src/mcp_server.rs`.

## Stability

- Additive changes (new request/response/event variants, new optional fields
  with serde defaults) are the norm; clients must ignore unknown fields and
  unknown event types.
- Renaming or removing a variant/field is a breaking change and needs a
  deliberate migration note in the release notes.
- The CLI renders responses textually for humans; scripts that need stable
  output should speak the JSON protocol directly rather than parsing CLI text.
