# Progress

Current as of 2026-08-14.

The desktop GUI is now an Electron + Solid.js app (`desktop/`) that talks to the
Rust `archcar` daemon over its socket. The former in-process GTK app
(`crates/gtk-app`) was retired; sections below describing "GTK" behavior refer
to the historical surface and are being superseded by the Electron surface.

## Current State

Archductor has a usable but rough GUI-first loop for one local repository:

1. Add or clone a repository as a project.
2. Edit app Shared defaults, repository-committed settings, and Local project
   overrides.
3. Create branch, prompt, GitHub issue, GitHub PR, or Linear workspaces.
4. Run setup/run scripts, terminal commands, and Shell/Codex/Claude/Cursor
   sessions inside a workspace.
5. Review diffs, todos, local comments, sibling conflicts, GitHub PR checks,
   PR comments, review threads, deployments, and merge blockers.
6. Stage review/check/comment/readiness context into the selected agent session.
7. Create, refresh, merge, and optionally archive GitHub PRs through local
   `gh` auth.
8. Restore archived workspaces and inspect saved Linux session history.

The app is not MVP-complete. Treat it as a working prototype with real product
paths and known rough edges.

## Archductor UX Strategy Alignment (2026-08-12)

`docs/2026-08-12-archductor-ux-backend-strategy.md` defines the product shape:
"Conductor feel, Archductor reach". These pieces of it now exist end to end
(core -> archcar -> CLI -> Electron):

- **Workspace intelligence objects** (`crates/core/src/workspace_intel.rs`):
  tasks, operational summaries (workspace/session/task/review/handoff scopes),
  branch-local context attachments, per-session diff contributions, and
  advisory session-overlap warnings. New tables: `tasks`, `summaries`,
  `context_attachments`, plus `chat_threads.task_id`/`intended_areas`.
- **Summary drafting**: `draft_workspace_summary` (goal, files touched,
  sessions, checks, blockers, next actions) and `draft_session_summary`
  (handoff notes per agent). This is the standalone-context quality bar when no
  external memory service is connected.
- **Per-agent diffs**: session contributions read touched files from both TUI
  chat events and managed-session `diff_file_change` provider events, and mark
  which of those files still differ in the branch.
- **PR handoff**: `draft_pull_request` builds a title/body from the summary,
  tasks, agent contributions, check evidence, and risks; `create_pull_request`
  is now reachable over archcar/CLI (previously core-only).
- **Right panel tabs** are the strategy set: Tasks, Summary, Files, Changes,
  Checks, Context, Review, PR. Nothing was dropped — Todos live under Tasks,
  Timeline under Summary, Checkpoints under Changes, Processes moved into the
  terminal dock. The dock is now a draggable, persisted vertical split.
- **Left rail indicators**: active agent count, blocked-task and open-task
  chips, and PR state per workspace row; `blocked` is a new status kind that
  outranks running/review in the status dot.
- **Background development tasks** (`crates/core/src/background_tasks.rs`):
  start from CLI/API -> archductor creates the workspace, opens a chat thread,
  spawns the managed agent, and queues the prompt; an archcar supervisor thread
  ticks every 10s and advances the task through checks -> summary -> optional
  commit/push/PR -> ready for review. Agent liveness comes from live session
  runtime state (a managed session's process stays alive between turns).
  Providers are restricted to codex/claude; a shell has no idle signal.

Reach, added 2026-08-13:

- **Remote access**: archcar can bind a TCP listener guarded by a shared token
  (`crates/core/src/archcar/remote.rs`). It is opt-in via
  `ARCHDUCTOR_ARCHCAR_LISTEN`, a bare port means loopback, and non-loopback
  binds log a warning. Every connection must send the token as its first line;
  a bad token gets a normal protocol error, not a decode failure. Clients point
  at it with `ARCHDUCTOR_ARCHCAR_REMOTE` + `ARCHDUCTOR_ARCHCAR_TOKEN`.
- **MCP server**: `archductor mcp serve` speaks MCP (2025-06-18) over stdio and
  maps 24 tools onto archcar requests — workspaces, tasks, sessions, prompts,
  summaries, context, changes/diffs, checks, review status, PR draft/create, and
  background tasks. No presentation state, per the strategy's non-goal.
  `--read-only` hides every mutating tool. Because the tools are archcar
  requests, an MCP client can drive a remote daemon by setting the two remote
  environment variables.
- **Native background service**: `archductor mcp setup` (or the desktop
  Settings card) installs and starts a per-user launchd agent on macOS or a
  systemd user unit on Linux (`crates/core/src/service.rs`), ensures the access
  token exists, and prints the MCP client configuration.
  `archductor service install|uninstall|status|token` manage it directly, and
  archcar exposes the same operations as RPCs so the app can do it.

Strategy gap closure, added 2026-08-14 (core -> archcar -> CLI -> Electron for
each):

- **Task model completed against the strategy doc**: tasks now carry a human
  `owner` (distinct from `owner_session_id`), `review_notes`, and a computed
  `linked_session_ids` list from `chat_threads.task_id`. CLI
  `update-task --owner/--review-notes`, MCP `update_task`, and desktop
  owner/review-notes prompts on the Tasks panel.
- **Session model first-class fields**: `chat_threads.model` is a real column
  (derived from harness metadata on create/update, surfaced on threads and
  contributions), and per-session command/check/run history is exposed as
  `list_session_runs` (CLI `archcar session-runs`, MCP `session_runs`, a
  "Show runs" toggle per contribution in the Summary tab).
- **Durable diff contributions**: `diff_contributions` table stores per-session
  files, still-present files, a written patch under
  `.context/archductor/contributions/`, the commands the daemon ran, and
  caller-supplied risks/blockers (`snapshot_diff_contribution` /
  `list_diff_contributions`; CLI `snapshot-contribution`/`diff-contributions`;
  MCP tools; desktop "Snapshot diff" per contribution). Stored risks/blockers
  feed the PR draft's Risks section.
- **Checkpoint compare**: `checkpoint_compare` diffs a checkpoint against the
  current working tree (truncated at 64 KiB), reachable as archcar
  `compare_checkpoint`, CLI `archductor checkpoint compare` and
  `archcar checkpoint-diff`, and a Compare button per checkpoint row in the
  desktop Checkpoints tab.
- **Multi-agent background tasks**: `StartBackgroundTask.extra_agents` runs
  one or more managed agents in the same background workspace, each with its
  own session and prompt (defaulting to the task prompt). CLI
  `--agent provider[=prompt]` (repeatable), MCP `extra_agents`, desktop
  "Extra agents" field in the background-task dialog. All sessions are linked
  to the workspace task, so per-agent provenance still works.
- **Notify when ready**: every background-task advance broadcasts a
  `background_task_updated` archcar event; the desktop shows an OS
  notification when a task reaches `ready`/`failed`.
- **Stable API documentation**: `docs/api.md` documents the external surface
  (socket/TCP transports, token auth, protocol shape, workflow objects, MCP,
  stability policy) and records the decision that archcar RPC + MCP *is* the
  API — no separate HTTP layer.
- **Server-hosted execution** (2026-08-14): a client machine can point every
  Archductor surface at a daemon running elsewhere. Connection resolution is
  env (`ARCHDUCTOR_ARCHCAR_REMOTE`/`_TOKEN`) > saved remote profile
  (`state/remote.json`, owner-only, shared by CLI and desktop) > local daemon.
  New `archductor remote connect|status|disconnect` (connect verifies the
  daemon before saving); the Electron main process re-reads the profile per
  connection, speaks TCP + token-line, and never spawns a local sidecar while
  a remote is configured; Settings gained a "Remote daemon" card (connect
  verifies and rolls back on failure, token never returns to the renderer).
  Server side was already in place: `archductor service install --listen`
  writes the listener into the launchd/systemd unit and provisions the token.
  `docs/api.md` has the deployment recipe.

Deliberately not built: Archivum context (the attachment `source` stays in the
protocol, but the Context tab's Archivum section is commented out rather than
advertising a capability that does not exist), multi-repo workspaces (the
product model stays one repository per project), and session/task-scoped
checkpoint creation — manual create/compare/restore/delete is the checkpoint
surface for now.

## Desktop Motion Layer and Module Split (2026-08-23)

The Electron UI had two CSS transitions and no keyframes in ~11,000 lines of
stylesheet. It now has a motion layer (`desktop/src/styles/motion.css` ->
`motion/`): duration/easing tokens, a named keyframe library, and one global
`prefers-reduced-motion` override, applied across chat, sidebar, dialogs,
toasts, menus, command palette, tabs and diff.

- **Generation loader.** A flowing dot-grid (`components/DotGridLoader.tsx`,
  wave arithmetic in `lib/dotGrid.ts`) renders as the last child of
  `.chat-messages`, so it trails the newest message inside the scroller.
  Shown while generating or starting, hidden when the agent is blocked on the
  user — `lib/chatGeneration.ts` is the single source for that, replacing four
  ad-hoc signals the composer read off the store.
- **Workspace PR-state icons.** `deriveWorkspacePrAction` now also returns a
  `state`. The action kind collapses six situations into `view`, which made
  merged, closed, conflicted, checks-failing, checks-running and behind-base
  render the same glyph; twelve states now have distinct glyphs and colours,
  shared by the sidebar and the PR bar.
- **File split.** `base.css` (5,695) and `theme.css` (5,299) became ordered
  manifests over per-surface files; `ChatSurface.tsx` (1,948) -> `pages/chat/*`;
  `Settings.tsx`, `Dialogs.tsx` and `bridge/protocol.ts` likewise. Largest
  source file is now 783 lines. Both splits were verified by byte-diffing the
  built bundle, which was unchanged.

Verified: 368 tests (52 files), `tsc --noEmit`, `pnpm build`, plus a live
Electron smoke against a scratch daemon — loader absent when idle, 56 dots
animating with distinct per-dot phase during a turn, absent again afterwards;
five PR-state icons rendering distinctly in the sidebar. Not app-verified:
checks-running, checks-failed, conflict and ready-to-merge icons, which need a
real GitHub checks summary; those are unit-covered only.

## Agent-Maintained Context (2026-08-23)

The workspace summary is now prose an agent writes, not a mechanical dump, and
the naming pipeline no longer depends on the agent answering a one-shot ask.

- **Summary is agent-authored.** `<archductor_metadata>` carries a `summary`
  field alongside the names; it is stored with the `archductor:agent` source ref
  and capped at 1,200 chars. `refresh_summary` refuses to overwrite an
  agent-authored body, and `draft_workspace_summary` shrank to a seed (goal,
  blockers, next actions) — the Files touched / Sessions / Checks sections are
  gone, because Changes, Files and Checks already show them. The Summary tab
  leads with the prose and tasks and no longer lists agent contributions.
- **Asking is paced, not one-shot.** The hidden block is built by
  `archductor_context_instruction` from an `ArchductorContextRequest` (naming
  and/or summary in one block). Naming retries up to `CHAT_NAMING_ATTEMPT_LIMIT`
  and only once the agent has answered something (`naming_requested_seq` vs the
  metadata cursor). The summary ask fires every `SUMMARY_ASK_INTERVAL` user
  turns and carries the stored prose so the agent revises rather than rewrites.
- **A naming floor.** A chat is titled from its first message immediately;
  workspace and branch fall back to a name derived from the request only after
  the ask is spent. A silent or non-managed agent no longer leaves a workspace
  on its codename.
- **Directives apply at the turn boundary.** `apply_agent_metadata_for_thread`
  runs on `TurnCompleted`/`SessionMessagesUpdated` against a per-thread
  `metadata_cursor_seq`; reading a transcript now only strips the block. A
  headless session gets renamed without a client watching it.
- **MCP is the primary channel.** `set_workspace_context` (archcar
  `ApplyAgentContext`) sets the summary and the names as a tool call, with the
  workspace resolved from `ARCHDUCTOR_WORKSPACE` or the session's cwd and the
  thread from `ARCHDUCTOR_THREAD_ID`. `archductor mcp serve --profile session`
  exposes six tools; `--profile full` is the external surface.
  `archductor mcp register` adds Archductor through each client's own
  `claude mcp add` / `codex mcp add`, so it appears like any other MCP server,
  with a Settings card (Clients -> Host Access) over the same archcar RPCs.
- **Claude also gets prompt and hooks.** `--append-system-prompt` carries the
  standing contract plus the stored summary; `SessionStart` and `PostToolUse`
  hooks answer with `additionalContext` — the contract at start, a staleness
  nudge mid-run, debounced through the same turn counter.

Verified: 888 core tests (the four known macOS-only failures aside), 391 desktop
tests, `tsc --noEmit`, clippy and fmt clean, a live archcar socket smoke where an
MCP `set_workspace_context` call renamed `berlin` to `context-mcp-wiring` and
stored the summary (a following `refresh-summary` reported `changed=false`), cwd
based workspace resolution with no env set, and an Electron smoke showing
"Agent-maintained · updated 3m ago" with the prose and tasks, plus the MCP
registration card reading both clients' live state. Not verified end to end: a
real claude session exercising the SessionStart/PostToolUse hooks, and the
register/unregister write path against a real `~/.claude.json` / `~/.codex/config.toml`.

## Conductor Reference Cross-Check (2026-08-06)

The Electron surface was cross-checked against Conductor's own reference docs
(diff-viewer, checks, workflow, parallel-agents, settings). archductor matches
the documented feature set; the concrete gaps found were closed: file-scoped
review comments beside the diff (diff-viewer), a locally-computed merge-readiness
"blockers" banner in Checks (checks), and the workflow keyboard shortcuts
Cmd/Ctrl+Shift+N/D/P (workflow). Remaining Conductor-parity items require live
GitHub `gh` / Linear auth to verify (PR checks/review/readiness detail, Linear
workspace source) and are intentionally not built blind.

## Implemented Surfaces

### Core And CLI

- SQLite-backed project, workspace, process, PR, todo, review, checkpoint,
  timeline, chat, and history state.
- Repository add/list/update/doctor plus shared/local settings import/export.
- App Shared settings import/export and effective settings precedence from
  built-in defaults through app Shared, repository-committed settings
  (including prompt packs), and Local project overrides.
- Workspace create/list/archive/restore/discard/delete/rename/duplicate.
- Workspace creation from branch/base, prompt, GitHub issue, GitHub PR, and
  Linear issue.
- Git worktree creation with `.context` initialization and stable
  per-workspace port allocation.
- Workspace branch create/checkout/rename/delete.
- Workspace timeline records for creation, duplication, branch changes, session
  lifecycle, PR/check actions, archive, restore, delete, and related events.
- `.worktreeinclude` precedence over settings file-copy globs.
- Repository settings for scripts, prompts, prompt pack metadata, environment,
  provider paths, Git behavior, merge rules, workspace defaults, view defaults,
  terminal preferences, keybindings, notification labels, and advanced TOML.
- Prompt pack files are bootstrapped under `.archductor/prompt-packs`.
- Effective prompt routing for first-chat General instructions, continue work,
  PR creation, commit/push, blocker resolution, setup/run assistants, code
  review staging, and local/PR check fixing. Shared/Local prompt saves refresh
  managed prompt snapshots for existing live workspaces.
- Monorepo working-directory defaults for scripts, terminal commands, editor
  launches, and agent sessions.
- Linked workspace directories with persisted records, symlinks under
  `.context/linked-directories`, and `ARCHDUCTOR_LINKED_*` environment.
- PTY-backed shell/session primitives, transcript logs, provider events, and
  stale-process reconciliation.
- Shell, Codex, and Claude CLI session commands. Cursor is available from
  desktop launch paths where configured, not from the current CLI
  `session --kind` enum.
- Immediate Codex delivery from desktop Ctrl+Enter and CLI
  `session send`/`archcar send --immediate`, using active-turn steer with
  transparent new-turn fallback.
- Archcar owns durable managed chat input queues in SQLite, exposes queue
  add/list/remove through the protocol and CLI, emits queue update events, and
  drains queued automatic input when the matching managed session becomes
  ready.
- Archcar-managed Claude Code stream-json sessions with local auth readiness,
  persistent input delivery, resumable controls, process-group interrupt,
  native hook settings, provider interaction records, and common CLI commands
  for listing/resolving provider interactions.
- Managed Codex and Claude descriptors report contract version 1 with the full
  required baseline in written conformance tests. Codex goals are native;
  Claude goals return a structured unsupported reason.
- Git status/diff/log, todos, review comments, checkpoints, conflicts, checks,
  PR summary, PR checks, PR thread resolve/reopen, PR merge, and history
  commands.
- GitHub-backed flows use local `gh` auth. Linear-backed workspace creation
  uses `LINEAR_API_KEY`.
- Release packaging scaffolding for tarball, AppImage, `.deb`, `.rpm`, AUR, and
  experimental Flatpak, plus a portable native Windows ZIP.
- Cross-platform process/path/shell boundaries for Windows, including AppData
  storage, `cmd.exe` scripts, Windows Terminal launch, `taskkill` process-tree
  shutdown, and loopback archcar IPC.
- CI compile gates cover native Windows, macOS where available, glibc Linux,
  musl Linux, and representative distro families.

### Desktop App (Electron + Solid.js)

The Electron renderer talks to `archcar` only over the socket (it has no
in-process `core` access), so every state change must flow through an
`ArchcarRequest`. All renderer actions and store state changes are logged via
`desktop/src/lib/log.ts`; the Electron main process appends them plus every IPC
request/response/event to `~/.local/state/archductor/desktop.log`. The archcar
sidecar logs every RPC on its side (`log_archcar_rpc`).

State-changing archcar parity with the retired GTK flows (protocol + server
handlers in `crates/core/src/archcar/{protocol,server}.rs`, TS in
`desktop/src/bridge/protocol.ts`, action layer `desktop/src/store/actions.ts`):

- Repository: `add_repository` (local path), `clone_repository` (git clone +
  add). UI: sidebar "+" → Add project dialog.
- Workspace creation: `create_workspace` (branch/base), `_from_prompt`,
  `_from_issue`, `_from_pull_request`, and `_from_linear`. UI: Projects
  "+ Workspace" dialog.
- Workspace lifecycle: `archive`/`restore`/`rename`/`duplicate`/`delete`
  (delete uses the lifecycle job; cleanup failures are logged, row still
  removed). UI: Projects row "⋯" → workspace actions dialog.
- Branch: `create_branch`/`checkout_branch`/`rename_workspace_branch`/
  `delete_branch`/`push_branch`. UI: workspace actions dialog + Checks tab.
- Pull request: `refresh_pull_request`, `merge_pull_request`. UI: Checks tab.
- Review: `add_review_comment`. UI: Review tab.
- Checkpoint: `delete_checkpoint` (alongside existing create/restore). UI:
  Checkpoints tab.
- Runtime scripts: `get_workspace_run_scripts`, `start_workspace_setup`,
  `start_workspace_run`, and `stop_workspace_run`. UI: Run dock shows
  configured run scripts with local/cloud/default status and starts Setup/Run or
  stops Run through archcar.
- Recovery: `recover_workspace_lifecycle_jobs` can be rerun from CLI and the
  Electron Settings page; archcar still runs the same recovery automatically on
  startup. Recovery also reconciles stale setup/run/check process rows whose
  child process is no longer alive, so interrupted archcar monitors do not leave
  those scripts stuck as running.
- Updates: the Electron Settings page can check the latest GitHub release and
  open the release page. Install/app replacement remains manual; there is no
  signed auto-updater yet.
- Linking: `link_workspace_directory`/`unlink_workspace_directory`. UI:
  workspace actions dialog.
- Provider default: `set_default_agent_provider`. UI: workspace actions dialog.

Workspace file editing: `read_workspace_file`/`write_workspace_file` RPCs (core
`WorkspaceStore::read_file`/`write_file`, path-traversal guarded, 2 MiB + binary
limits) back a center-pane file editor. The desktop FileView now has Diff/Edit
tabs; Edit loads real UTF-8 content into a syntax-highlighted editor (transparent
textarea layered over a highlight.js `<pre>`, scroll-synced, language from file
extension) with Ctrl/Cmd+S save. CLI exposes `archcar read-file`/`write-file`
for the same boundary.

Settings editing: `get_settings_source`/`save_settings` RPCs read and write one
layer's raw TOML (global app-shared, repository-committed, or local override)
through the validating `save_*_from_toml` path. The desktop Settings page is now
a split editor — an editable Source textarea (Ctrl/Cmd+S save) beside the
read-only Effective merge, with a Repository/Local layer toggle for repo scope.
CLI: `archcar settings-source` / `archcar save-settings`.

Commit from the app: `commit_workspace_changes` RPC (CLI `archcar commit
<ws> <msg> --stage-all`) stages all (optional) and commits with a message. The
Changes panel gained a commit box (message + "Stage all & commit") plus a
"Suggest" button backed by `get_commit_message_draft` (heuristic message from
changed files; CLI `archcar commit-draft`), and a Recent-commits view
(`get_recent_commits`) whose rows are clickable to open that commit's diff in the
center (`get_commit_diff` / git show, CLI `archcar commit-diff`) — a complete
in-app git review/commit surface.

Workspace creation from Linear: the create-workspace dialog gained a "Linear"
source (issue-id input) backed by a `create_workspace_from_linear` RPC (core
`create_from_linear_issue`, CLI `archcar create-from-linear`). The RPC→server→
core wiring is verified via socket smoke (no key → clear "requires
LINEAR_API_KEY" error); the live create needs `LINEAR_API_KEY` in the daemon
env and is not smoke-verified here. The dialog now offers all GTK sources:
Prompt, Branch, Github (issue/PR), and Linear.

Workspace creation from branch/base: the create-workspace dialog gained a
"Branch" source (name + branch + optional base) alongside Prompt and Github,
calling the existing `create_workspace` RPC — restoring the GTK branch/base
creation flow. The base field autocompletes from the repo's local branches via a
new `list_repository_branches` RPC (CLI `archcar branches`).

Linked directories: `list_linked_directories` RPC (CLI `archcar linked-dirs`)
lists the directories linked from other workspaces into this one; the
workspace-actions dialog now shows the current links beneath its Link/Unlink
controls (previously link/unlink existed but there was no way to see them).

Conflicts: `list_workspace_conflicts` RPC (CLI `archcar conflicts`) surfaces
sibling workspaces whose changes overlap this one's files. Shown as a
"Conflicting workspaces" section in the Checks tab.

Timeline: `list_workspace_timeline` RPC (CLI `archcar timeline`) surfaces the
workspace lifecycle events (creation, branch changes, session lifecycle,
PR/check actions, commits, archive, …). Restored as a Timeline right-panel tab
(newest first), matching the GTK Timeline surface.

Spotlight testing: `get_spotlight_status`/`start_spotlight`/`stop_spotlight`
RPCs (CLI `archcar spotlight-status`/`spotlight-start`/`spotlight-stop`) expose
core's spotlight slice — start applies the workspace's tracked patch to the
repository root so the running app reflects it, stop reverts. The Processes tab
shows a Spotlight status line with Start/Stop (requires `spotlight_testing` in
settings). Restores the GTK Spotlight testing feature; conductor's "Spotlight
testing" from the workflow doc.

PR readiness detail: `get_pull_request_readiness` RPC (CLI `archcar
pr-readiness <ws>`) surfaces core's `pull_request_readiness_text` (`gh pr view`
— CI/status/deployment/review-thread signals conductor's Checks doc lists but
the DB-only summary lacks). The Checks tab has a "PR readiness" button that
loads the detail into a `<pre>` on demand. Network/gh-auth gated: boundary path
(missing workspace) smoke-verified to return a clear error; the live gh path is
auth-gated and not smoke-verified here.

Runtime controls: `run_workspace_script`/`stop_workspace_script`/`get_run_log`
RPCs expose the existing core run/stop/log-tail behavior over archcar (CLI:
`archcar run-script`/`stop-script`/`run-log`). The Processes tab gained Run/Stop
buttons and a latest-run-log view, restoring the GTK runtime controls.

Prompt packs: `list_prompt_packs`/`set_active_prompt_pack` RPCs (CLI `archcar
prompt-packs`/`set-prompt-pack`) enumerate a repository's
`.archductor/prompt-packs/*.toml`, report the committed-layer active pack, and
switch it by editing the `[prompt_pack]` table in the raw committed TOML
(preserving other fields). The Settings page shows packs as chips; clicking a
non-active chip switches to it one-click.

Local check runner: `list_workspace_checks`/`run_workspace_check` RPCs surface
the repository's configured `[scripts]` test/lint/typecheck/build commands and
run one as a tracked Check process, and read its latest output via
`get_check_log` (CLI: `archcar check-list`/`run-check`/`check-log`). The Checks
tab lists each configured check with a Run button and shows the latest check log.

Status indicators: sidebar workspace rows show a colored status dot and
dashboard cards a matching left accent stripe (green=running, blue=open PR,
amber=uncommitted changes, grey=idle, dim=archived) from a pure, unit-tested
`desktop/src/lib/workspaceStatus.ts`.

Appearance controls: the Settings page restores the GTK theme/accent/density
runtime controls. `prefsStore` now persists `theme` (dark/light), `accent`
(amber/blue/green/rose, also driving the global `--lc-accent` token), and
`density` (compact/cozy/comfortable) to localStorage; an App effect toggles the
existing `lc-theme-*`/`lc-accent-*`/`lc-density-*` class hooks on `<body>`. The
`lc-theme-light` CSS was originally partial (dashboard/cards only), leaving the
command center, Settings panes, History rows, and dialogs dark/unreadable in
light mode; it is now completed across all main surfaces, each verified by
rendering the built renderer (stubbed archcar bridge, forced light prefs) in
headless chromium — see the reusable full-app preview recipe in the session
memory.

Command palette: Cmd/Ctrl+K global launcher (`desktop/src/components/
CommandPalette.tsx`) restores the GTK command palette. Fuzzy-filters
(`desktop/src/lib/fuzzy.ts`, unit-tested) across page navigation, workspace
jumps, workspace-tab switches, and create/lifecycle actions (add project, new
workspace, workspace actions). Keyboard-first: ↑/↓ move, Enter runs, Esc closes. The palette also drives
appearance (switch theme, cycle accent) and opens the keyboard-shortcuts help,
making it a real control surface.

After a mutation acks, the renderer re-pulls the workspace/repository inventory
(archcar has no inventory-changed event), mirroring the GTK sidebar's
post-mutation refresh. Read surfaces are wired and now all reachable: chat +
open files in the center; Browse, Changes, Checks, Review, Todos, Checkpoints,
and Processes as right-panel tabs; terminals in the run dock. (The Checks/
Review/Todos/Checkpoints/Processes panel components existed earlier but were
unrendered until wired into the right-panel tab strip.)

Now ported to Electron from the historical GTK surface: force-push (Checks
panel), PR review-thread resolve/reopen (Review panel), editable settings source
(Settings page), Linear workspace source creation, prompt-pack switching, and a
Cmd/Ctrl+K command palette. Still outstanding: full visual parity is an ongoing
refinement, and hooks / a local check-runner UI remain unbuilt.

Historical GTK surface (superseded, kept for reference):

- GTK/libadwaita app with Dashboard, Projects, History, and Workspace pages.
  Settings, Dashboard filters, and History tabs
  reuse the standard close-free workspace chat-tab presentation.
- Project onboarding from local repository path or Git clone URL.
- Scope-aware Settings page: Shared applies machine-wide defaults to every
  project without a project selector; Local selects one project and edits only
  its project/workspace overrides. Local prompt editors show inherited values
  without copying them into the override until edited.
- Repository settings for committed team configuration remain available through
  the Projects surface and remain between app Shared and Local in effective
  precedence.
- Workspace creation from branch/base, prompt, GitHub issue, GitHub PR, and
  Linear issue with source preflight feedback.
- Workspace command center with status header, agents panel, runtime panel,
  Changes, Checks, Review, Chat/Terminal, Big Terminal, Todos, Processes,
  Branch, Timeline, Checkpoints, lifecycle actions, and linked-directory panel.
- Workspace delete lifecycle jobs own artifact cleanup and retry behavior; GTK
  surfaces invoke the lifecycle job instead of starting detached duplicate
  cleanup.
- Agent/session surface for Shell, Codex, Claude, and Cursor session launch
  paths, transcript persistence, selected-session input, staged review prompts,
  provider/auth/MCP status, harness metadata, prompt preview, profile selector,
  and stop notifications.
- GTK uses managed harness descriptors for Codex and Claude live controls:
  provider/model/thinking are baseline controls, Codex-only goals remain
  visible, and Claude hides unsupported goals.
- Plain Enter follow-up queueing goes through the Archcar durable queue,
  Ctrl+Enter immediate Codex delivery steers active turns, and GTK queue-row
  reconciliation follows Archcar queue responses/events without broad streaming
  chat refreshes.
- GTK composer Ctrl+V paste saves images and long text under
  `.context/archductor/{chatId}/`, inserts a shared Archductor attachment token,
  and renders persisted user-message tokens as compact attachment chips.
- GTK keeps hot workspace/chat UI state in watched AppState slices for
  selection, refresh requests, pending workspace phases, pending chat targets,
  and a composer queue cache. Workspace and chat creation publish optimistic
  status, keep the composer usable, and wake Archcar to drain queued input after
  the real workspace/chat thread and agent session are ready.
- GTK refreshes use typed events for routine runtime, review, workspace
  inventory, terminal, and chat changes; `RefreshScope::All` is reserved for
  explicit manual refresh and startup reconciliation.
- GTK refreshes support scoped RAII listeners for payload-owned row updates.
  Sidebar workspace diff stats use exact-workspace
  `WorkspaceDiffStatsChanged { workspace, additions, deletions }` listeners and
  no longer wake workspace nav-row/sidebar/shell handlers.
- GTK background sync samples persisted running chat markers off the main timer
  callback, coalesces lifecycle refreshes by workspace, and avoids loading
  hidden full chat timelines for off-focus work.
- Running chat sessions are sampled in the background with lightweight ids and
  sequence markers so sidebar/dashboard/history and chat tab state can update
  while another workspace or thread is selected.
- Terminal surfaces for one-shot commands, PTY shell tabs, transcript
  persistence/search/reload, basic ANSI/control redraw handling, alternate
  screen restoration, configured terminal font, configured scrollback, and
  command preset buttons.
- Runtime controls for setup/run/stop scripts, log tails, and the current
  Spotlight testing slice.
- Changes/review/checks surfaces for changed files, diffs, recent commits,
  branch push state, local comments, safe tracked-file revert, PR create/refresh,
  PR checks/comments/reviews, PR readiness summary, review-thread actions,
  merge blockers, merge, and archive-after-merge.
- Dashboard cards open workspaces and group them as Ready, Running, Review, or
  Archived, with filters for All projects and every registered project.
- History defaults to a Workspaces tab with All/Active/Archived filters and also
  provides a Chats tab for saved Linux sessions and older macOS Conductor chats
  when the upstream database exists.
- Command palette, global refresh/sidebar shortcuts, tab/deep-link navigation,
  view defaults, theme/accent/density classes, and terminal presets.

## Known Gaps

- Desktop (Electron) app polish and visual parity with the old GTK surface are
  incomplete; several historical GTK affordances are not yet ported.
- Terminal rendering handles common ANSI/control redraws but is not a full
  terminal emulator.
- Project onboarding/settings need more polish and clearer managed/user setting
  separation.
- Remote archcar access is token-only: there is no TLS, no per-client identity,
  and no revocation beyond rotating the single token. Expose a non-loopback
  listener only behind a firewall, VPN, SSH tunnel, or a reverse proxy you
  trust. Server-hosted use assumes agent CLIs and `gh` auth exist on the
  server; when they do not, the setup gate says so and offers Disconnect
  instead of wedging the app.
- Under a remote profile the direct-store CLI commands (`repo`, `workspace`,
  `status`, and 16 others) refuse rather than work: they read the local
  database, so `archductor archcar <command>` is the remote-backed path. The
  New workspace ▸ GitHub tab is also unavailable remotely — `gh` resolves the
  repo from a working directory that lives on the daemon's machine and there is
  no daemon-side RPC for that listing yet.
- The service installer covers launchd (macOS) and systemd user units (Linux).
  Windows reports "unsupported"; run `archcar` yourself there.
- The launchd/systemd unit does not carry `XDG_*` overrides, so an installed
  service always uses the default per-user paths, not an isolated dev instance.
- Checkpoints support manual create/compare/restore/delete; session-scoped and
  task-scoped checkpoint creation is intentionally unbuilt.
- There is no Archivum client. The Context tab's Archivum section is commented
  out; only branch-local notes and files are surfaced.
- Prompt-pack import/export, naming templates, hooks, and richer notifications
  are not fully surfaced in the GUI. (Now surfaced: theme/accent/density
  controls, prompt-pack switching, the local check runner, and run/stop/log
  runtime controls.)
- `new_workspace`, `summarize_session`, `handoff`, `rename_branch`, and
  `refactor_style` prompts remain editable inherited defaults without dedicated
  surfaced actions.
- Runtime ownership is now Archcar-managed for Codex and Claude Code in written
  tests. Live Claude Code auth/session/interaction smokes still need to be run
  on a machine with an authenticated Claude CLI before calling the parity slice
  manually validated.
- Codex unsafe approval/sandbox bypass needs explicit product policy before a
  broad public launch.
- Live GitHub validation requires authenticated `gh`; live Linear validation
  requires `LINEAR_API_KEY`.
- Native Windows is a preview target. The workspace compiles there and the
  release workflow assembles a portable ZIP, but real Windows install/launch,
  Electron runtime, PTY, provider, upgrade, and checksum smoke remain required
  before calling the package release-ready.
- Linux remains the manually validated primary product target. macOS and
  Windows should keep compile/basic smoke coverage green where tooling is
  available. CI covers GNU and musl plus representative distro families;
  individual package channels still require install/launch/upgrade validation.
- Release packaging still needs full manual validation on target distros before
  public launch.
- Update install is a manual release-download flow until package signing,
  channel metadata, rollback/yank policy, and per-platform install/upgrade
  validation are complete.

## Agent Context Policy

Coding agents should read `.codex/AGENTS.md` or `claude/CLAUDE.md`, depending on
agent, then this `progress.md` file. Load the larger durable docs only when the
task needs that context:

- Product scope or feature priority: `docs/conductor-gui-mvp-handoff.md` and
  `docs/mvp-scope.md`
- Manual release/app verification: `docs/manual-testing-checklist.md`
- Upstream Conductor parity: `docs/archductor-docs-parity-map.md`
- User-facing install, workflow, or configuration docs: `README.md`

Dated one-off implementation plans/specs are not startup context. Keep only
current durable docs and active status notes; do not recreate historical task
artifacts under `docs/superpowers` or `.superpowers`.

## Verification Standard

Keep docs grounded in current evidence. When a feature exists only in core,
CLI, or Electron desktop, say which layer is implemented or verified. Historical
GTK evidence is retained only as legacy context.

Before calling behavior done, name:

- written tests
- CLI smoke
- Electron desktop smoke

If one layer is skipped, say exactly why.

## Recent Verification

Client switcher on 2026-08-20:

- A machine can now save any number of daemons and move between them from a
  picker above the sidebar nav. `state/clients.json` holds the list;
  `state/remote.json` stays the *selection* and is rewritten on every switch, so
  `configured_remote_endpoint`, the CLI, MCP, and the desktop bridge all keep
  reading one file and follow the picker with no changes of their own. A machine
  that only ever ran `remote connect` has its existing profile adopted as the
  first saved client, so upgrading does not drop the connection.
- Switching re-pulls the workspace inventory and re-probes setup readiness,
  because both belong to the daemon being left.
- CLI gained `remote list`, `remote use <client>`, and `remote remove <client>`;
  `remote connect --label` saves-and-activates and `remote disconnect` returns to
  this machine while keeping the client saved. Selection stays machine-wide, so
  a terminal and the window never target different servers.
- Settings ▸ Archcars ▸ Clients is now the manager (add / use / rename /
  forget). `ARCHDUCTOR_ARCHCAR_REMOTE` still wins and puts both surfaces into a
  read-only "pinned by environment" state.
- Written tests: core `archcar::remote` (15, 8 new covering the mirror, slug
  ids, upsert-by-address, profile adoption, dangling active id, owner-only
  perms), `archductor` bin (39), desktop `pnpm test` (278, 8 new asserting the
  TS mirror matches the Rust rules).
- Live smoke: two containerized daemons on 7451/7452 with different repos.
  CLI `remote list`/`use` switched between them and `archcar workspaces`
  returned each machine's own workspace; Playwright drove the sidebar picker
  through Alpha → Beta → This machine → Alpha and asserted the sidebar showed
  only that daemon's inventory each time.
- Settings now replaces the workspace sidebar instead of rendering beside it —
  two navigation rails were on screen at once. Its back row falls back to the
  dashboard when there is no history to pop (it is the only way out now), and
  on macOS the rail reserves the traffic-light strip the workspace sidebar's
  chrome row used to hold.
- Known nit found while testing: piping CLI output into `head` panics on
  `Broken pipe` instead of exiting quietly. Cosmetic, not fixed here.

Remote-client hardening on 2026-08-20 (first real two-host run):

- Probed with a Linux `archcar` in Docker and the macOS client against it, so
  client and daemon had genuinely separate filesystems for the first time —
  everything before this was loopback with a shared disk. `archcar` links no
  GTK/GLib/X11/Wayland and the container had no `DISPLAY`, so the daemon half is
  confirmed headless; repo add, worktree create, file list, write-file, changes,
  and diff all served correctly over TCP at 12–90ms.
- Fixed: the blocking setup modal probes whichever daemon is configured, so a
  server without `gh`/Codex/Claude made the app unrecoverable — Settings, and
  its Disconnect button, sat behind the scrim. The gate now names the host the
  rows describe and carries its own Disconnect; readiness is also re-probed when
  the connection changes instead of staying stale until restart.
- Fixed: `fs:path-exists`, `shell:open-external`, `shell:open-workspace-app`,
  `gh:repo-avatar`, and `gh:list-work` ran against client-local paths while the
  daemon owned them (`fs:list-workspace-files` was already guarded). They now
  refuse with the address and the way back, and the "Open in …" items toast that
  reason instead of failing silently. `path-exists` answers "exists" under a
  remote so remote repositories are not pruned as deleted.
- Fixed: `archductor repo|workspace|status|…` (19 command groups) opened this
  machine's SQLite while `remote status` reported the server, silently building a
  second inventory. They now refuse and point at `archductor archcar <command>`.
- Added `archcar add-repository` and `archcar create-workspace`: the RPCs
  existed but had no CLI verb, so a remote-only client could not bootstrap
  anything.
- Add-project's `Browse…` is disabled under a remote (it browses the wrong
  machine) and the dialog says the path belongs to the daemon host.
- Written tests: `archductor` bin (39, incl. three new for the refusal map and
  the new verbs), desktop `pnpm test` (270, incl. new `remoteHandlerBlock` and
  `shellAction` cases), `pnpm typecheck`, `pnpm build`.
- Live smoke: CLI refusal and both new verbs against the containerized daemon;
  Playwright drove the real window through the gate → Disconnect → Settings
  recovery (gate cleared 1034ms after the click) and confirmed the toast.
- Not done here: routing the 19 direct-store CLI command groups through
  `ArchcarClient` (they refuse rather than work remotely), a daemon-side RPC for
  the GitHub issue/PR listing, and `gh:list-repos` still uses the client's `gh`
  auth while the clone happens on the server.

Server-hosted execution on 2026-08-14:

- Written tests: `archcar::remote` (remote profile round-trip, owner-only
  permissions, profile→endpoint resolution, empty-field rejection) pass;
  desktop `electron/archcar.test.ts` (7) covers env>profile>local resolution,
  malformed profiles, and a real TCP round-trip where the bridge sends the
  token line then the request envelope against a fake daemon.
- Live smoke (isolated `XDG_*`, daemon under
  `ARCHDUCTOR_ARCHCAR_LISTEN=127.0.0.1:7451`): `remote connect` with a wrong
  token printed `archcar authentication failed`; with the right token it
  verified, saved the profile, and a plain `archductor archcar workspaces`
  (no env vars) listed real workspaces over TCP via the profile;
  `remote status` reported source; `remote disconnect` returned to the local
  socket.
- Desktop `pnpm typecheck`, `pnpm test` (75), `pnpm build` pass.
- Not verified here: a true two-machine deployment (needs a second host) and
  an interactive Electron session against a remote daemon — the transport and
  resolution logic are covered by the written TCP test; the Settings card is
  typecheck/build-verified.

Strategy gap closure (task/session/diff provenance, checkpoint compare,
multi-agent background, notify, API doc) on 2026-08-14:

- Written tests: `cargo test -p archductor-core --lib` — 726 passed; the only
  4 failures are the pre-existing macOS ones listed below. New coverage:
  `task_records_human_owner_review_notes_and_linked_sessions`,
  `session_model_is_first_class_and_run_history_is_scoped`,
  `diff_contributions_snapshot_files_patch_and_provenance`,
  `checkpoint_compare_diffs_checkpoint_against_current_worktree`, and an
  extra-agent validation case in
  `unmanaged_providers_are_rejected_before_a_workspace_is_created`.
- `cargo test -p archductor` (36 + 14 + 1 + 3 + 1), `cargo fmt --all --check`,
  `cargo clippy -p archductor-core -p archductor -p archcar --all-targets
  -- -D warnings` all pass.
- Desktop `pnpm typecheck`, `pnpm test` (68), `pnpm build` all pass.
- Live socket smoke (isolated `XDG_*`, real DB untouched):
  `update-task --owner/--review-notes` round-trip; `session-runs` over the
  socket; contributions showing `model=`; `snapshot-contribution` writing a
  real patch file plus risks/blockers into `diff-contributions`;
  `checkpoint-diff` and `checkpoint compare` printing the live diff; and
  `start-background-task --agent codex` creating one workspace with two
  managed codex sessions, both linked to the workspace task
  (`sessions: 2,3`), advancing to `ready`.
- Not verified live: the desktop OS notification itself (needs an interactive
  Electron session; the event broadcast and renderer wiring are covered by
  typecheck/build), and background PR creation (needs authenticated `gh`).

Remote access, MCP server, and background service on 2026-08-13:

- Added `archcar/remote.rs` (token file, TCP bind, handshake), `service.rs`
  (launchd/systemd unit generation and lifecycle), and `mcp_server.rs` (stdio
  MCP with 24 tools), plus a `DuplexStream` abstraction so archcar serves the
  same RPCs over the local endpoint and TCP.
- Added `archductor mcp serve`, `archductor mcp setup`, and
  `archductor service install|uninstall|status|token`, plus archcar RPCs
  (`get_service_status`, `install_service`, `uninstall_service`,
  `get_remote_access`, `rotate_remote_token`) and a desktop Settings card.
- Passed `cargo test -p archductor-core --lib` (718 passed; the 4 failures are
  the pre-existing macOS ones listed above), `cargo test -p archductor`,
  `cargo fmt --all -- --check`, and
  `cargo clippy -p archductor-core -p archductor -p archcar --all-targets -- -D warnings`.
- Passed desktop `pnpm typecheck`, `pnpm test` (68), `pnpm build`.
- Live smoke, isolated `XDG_*` dirs, daemon started with
  `ARCHDUCTOR_ARCHCAR_LISTEN=127.0.0.1:7451`: MCP `initialize` returned the
  protocol version, `tools/list` returned 24 tools, and
  `tools/call list_workspaces` returned the real workspace inventory.
- Live remote smoke: with `ARCHDUCTOR_ARCHCAR_REMOTE` + `ARCHDUCTOR_ARCHCAR_TOKEN`
  set and the local `XDG_*` unset, `archcar workspaces` and an MCP `tools/call`
  both drove the daemon over TCP; a wrong token printed
  `archcar authentication failed`.
- Live service smoke on macOS with a sandboxed `HOME`: `service install`
  wrote the plist, `launchctl list` showed the job, `service status` reported it
  running, `mcp setup` printed the client configuration and token, and
  `service uninstall` removed both the job and the plist with nothing left in
  the real `HOME`. The systemd path is covered by unit tests only — no Linux
  machine was available here.

Archductor UX strategy slice on 2026-08-12:

- Added `workspace_intel.rs` (tasks/summaries/context/contributions/overlaps)
  and `background_tasks.rs` (background development task state machine) with
  17 new written tests.
- Added archcar requests for tasks, summaries, context attachments, session
  contributions/overlaps, session-task assignment, intended areas, PR draft/
  create, and background task start/list/get/cancel/tick, with matching CLI
  commands and TypeScript protocol types.
- Electron: new Tasks/Summary/Context/PR panels, right-panel tab set from the
  strategy doc, resizable terminal dock with a Processes tab, dashboard
  background-task strip, and a "New background task" dialog.
- Passed `cargo test -p archductor-core --lib workspace_intel` (10),
  `background_tasks` (7), `archcar::protocol` (37), and
  `workspace_intelligence_dispatch_end_to_end`.
- Passed `cargo test -p archductor` (35 + 14 + 1).
- Passed `cargo fmt --all -- --check` and
  `cargo clippy -p archductor-core -p archductor -p archcar --all-targets -- -D warnings`.
- Passed desktop `pnpm typecheck`, `pnpm test` (68 tests), `pnpm build`.
- Live socket smoke against `target/debug/archcar` with isolated
  `XDG_DATA_HOME`/`XDG_STATE_HOME`: create-task/tasks/update-task,
  draft-summary/save-summary/summaries, add-context/context/remove-context,
  assign-session-task, session-areas, contributions, overlaps, and pr-draft all
  round-tripped.
- Live background-task smoke with a real managed Codex session: the daemon
  created the workspace, spawned the agent, delivered the queued prompt (the
  agent edited `README.md`), and then advanced the task through
  `running -> summarizing -> ready`, writing the workspace summary. Per-session
  contributions reported the touched file afterwards.
- Not verified here: background PR creation (needs authenticated `gh` and a
  remote), and the managed **Claude** background path — a live Claude session on
  this machine stayed `ready=false` under local SessionStart hooks, so its
  queued prompt never drained. That is the pre-existing managed-Claude
  readiness gap, not the background-task layer.
- Pre-existing macOS test failures unrelated to this work (also fail at HEAD):
  `session_launch_uses_configured_monorepo_working_directory`,
  `setup_workspace_uses_configured_monorepo_working_directory`,
  `terminal_command_uses_configured_monorepo_working_directory` (`/var` vs
  `/private/var`), and
  `raw_terminal_write_failure_emits_error_and_terminates_session`.

Conductor script baseline + Electron run dock/update/recovery on 2026-08-11:

- Added Conductor-style `[scripts.run.<id>]` parsing with `command`,
  `available_in`, `default`, and `icon`, while preserving legacy
  `scripts.run = "..."`.
- Structured run scripts select the default command for the existing run path;
  `available_in` validates to `local` and/or `cloud`.
- Added archcar `get_workspace_run_scripts`, `start_workspace_setup`,
  `start_workspace_run`, and `stop_workspace_run` requests with compact process
  summaries and CLI
  response rendering.
- Electron Run dock now shows configured run scripts with local/cloud/default
  status and has buttons to start Setup, start the default Run script, or stop
  Run through archcar.
- Electron Settings now has a manual update check against GitHub releases and a
  recovery check that reruns pending workspace lifecycle recovery through
  archcar, including stale setup/run/check process reconciliation. The same
  recovery request is exposed through the CLI archcar command surface.
- Added startup recovery for stale setup/run/check process rows and written
  coverage for dead script process reconciliation.
- Added Electron/archcar Linear workspace creation so the New workspace dialog
  can create from a Linear issue when `LINEAR_API_KEY` is available.
- Passed `cargo test -p archductor-core structured_run_script -- --nocapture`.
- Passed `cargo test -p archductor-core script_process_reconciliation --lib`.
- Passed `cargo test -p archductor-core workspace_run_scripts -- --nocapture`.
- Passed `cargo test -p archductor-core workspace_script_start -- --nocapture`.
- Passed `cargo test -p archductor`.
- Passed `cargo clippy -p archductor-core -p archductor -p archcar --all-targets -- -D warnings`.
- Passed CLI smoke `cargo run -p archductor -- doctor`.
- Passed desktop `pnpm typecheck`, `pnpm test` (24 tests), and `pnpm build`.

Electron/manual checklist alignment on 2026-08-11:

- Replaced active GTK verification language in agent instructions, MVP docs,
  README platform notes, and manual checklist with Electron desktop validation.
- Added a basic Conductor behavior baseline to the manual checklist covering
  fetched base branches, isolated worktrees/branches, `.context`, per-workspace
  ports, non-interactive scripts, `ARCHDUCTOR_*` environment, files-to-copy
  precedence, and missing tool/auth states.
- Added macOS compile smoke expectations and updated Windows preview smoke to
  target the packaged Electron app instead of the retired GTK binary.
- Passed `cargo test -p archductor-core worktreeinclude -- --nocapture`.
- Passed `cargo test -p archductor-core create_workspace -- --nocapture`.
- Passed `cargo test -p archductor-core run_workspace_executes_run_script_with_conductor_environment -- --nocapture`.
- Passed `cargo test -p archductor-core explicit_remote_base_fetch_preserves_local_commits -- --nocapture`.
- Passed CLI smoke `cargo run -p archductor -- doctor`.
- Passed desktop `pnpm typecheck`, `pnpm test` (20 tests), and `pnpm build`.

Electron archcar state-change parity + logging on 2026-07-29:

- Added 23 state-changing `ArchcarRequest` variants (repository add/clone,
  workspace create ×4 sources + lifecycle ×5, branch ×5, PR ×2, review comment,
  checkpoint delete, dir link/unlink, default provider) with server handlers,
  TS protocol, an action layer, and UI triggers.
- Added renderer→main→logfile logging of every action, state change, and RPC.
- Passed `cargo test -p archductor-core archcar::` (128 tests, incl. protocol
  round-trips and an end-to-end dispatch: add repo → create → rename →
  archive/restore → delete).
- Passed `cargo fmt --all -- --check` and
  `cargo clippy -p archductor-core -p archductor -p archcar --all-targets -- -D warnings`.
- Passed desktop `pnpm typecheck`, `pnpm test` (6 tests), `pnpm build`.
- Live socket smoke against `target/debug/archcar` (isolated `XDG_DATA_HOME` +
  `XDG_STATE_HOME` temp dirs, real DB untouched): add_repository,
  create_workspace, list/delete_workspace, create_branch, checkout_branch,
  add_review_comment (+ list), and set_default_agent_provider all round-tripped.

GTK scoped refresh listener validation on 2026-07-24:

- Passed `cargo test -p archductor-gtk workspace_diff_stats_subscription`.
- Passed `cargo test -p archductor-gtk refresh --no-fail-fast`.
- Passed `cargo test -p archductor-gtk sidebar --no-fail-fast`.
- Passed `cargo fmt --all -- --check`.
- Passed `cargo clippy -p archductor-gtk --all-targets -- -D warnings`.
- CLI smoke not applicable; this slice changes only GTK refresh routing and
  docs.

Claude Code Archcar parity written verification on 2026-07-16:

- Passed `cargo fmt --all -- --check`.
- Passed `cargo clippy -p archductor-core -p archductor -p archductor-gtk --all-targets -- -D warnings`.
- Passed `cargo test -p archductor-core archcar::harness_conformance --lib`.
- Passed `cargo test -p archductor-core`.
- Passed `cargo test -p archductor`.
- Passed `cargo test -p archductor-gtk`.
- Passed `cargo build -p archductor-gtk`.
- `claude auth status` succeeded with local first-party `claude.ai` auth; no API
  key prompt was required.
- GTK Xvfb launch reached startup under `timeout 8 xvfb-run -a
  target/debug/archductor-gtk`, but emitted existing runtime warnings for DRI3,
  unsupported libadwaita dark-theme setting, CSS `text-align`, and missing
  accessibility bus. Treat GTK runtime smoke as started-with-warnings, not clean.

Not yet manually smoke-verified in this branch:

- Live Claude first-send/follow-up through Archcar.
- Two simultaneous Claude native thread IDs.
- Live queue/immediate/interrupt/model/effort/permission-mode behavior.
- Live permission/question/plan interaction cards in Electron desktop.
- Archcar restart with a pending Claude interaction.

## Context Management (added 2026-08-18)

- Summary is the first right-panel tab before Files, and it contains the
  workspace summary, current-chat context, tasks, todos, and agent
  contributions in one combined surface.
- archcar continuously refreshes workspace and current-chat summaries after
  turns, message updates, task changes, and background-task progress, with an
  evidence-hash cursor (`summary_refresh_state`) so unchanged evidence skips
  rewrites. Changed summaries broadcast `summary_updated`; task mutations
  broadcast `task_updated`.
- MCP and CLI expose `refresh_summary`, `get_context_briefing`, and
  `sync_chat_tasks` so AI context management uses the same primitives as the
  human UI. Verified with core/CLI/renderer tests, a live socket smoke
  (create-task → `task_updated` + `summary_updated` events), CLI smokes for
  refresh/briefing/sync, an MCP stdio tools/list + tools/call smoke, and an
  Electron boot smoke against an isolated daemon. Check-run completion has no
  dedicated server hook; check status flows into summaries on the next
  turn/task/background event instead.

## New-chat context picker (added 2026-08-18)

- The empty chat screen now reads "New chat in {branch}" and offers two chip
  rows: recent chat transcripts (default 8 non-empty chats, newest first) and
  plan markdown from the workspace's `.context/plans/`. Picking chips attaches
  their text to the chat's next message and then clears; a failed send restores
  the picks along with the composer text.
- Transcripts carry the user/agent conversation only. Tool calls live in
  `chat_events` and `/model`-style control rows are `system` messages, so
  neither is attached.
- New read-only RPCs: `list_chat_transcripts`, `get_chat_transcript`,
  `list_context_plans` (plan bodies are read with `read_workspace_file`), each
  with an `archductor archcar` subcommand. Verified with core unit tests,
  renderer vitest suites, and a live socket smoke against an isolated daemon.
- `Icon` now stores each glyph as a factory (`() => JSX.Element`). Solid JSX
  evaluates to real DOM nodes, so the previous shared node was *moved* into the
  last `<Icon>` that rendered a given name and every earlier one drew blank —
  visible as soon as a list rendered the same icon twice (the new chips, and the
  sidebar's repeated `+` buttons).
- Electron smoke (isolated daemon, seeded repo/workspace/chats/plans): the empty
  chat reads "New chat in feature/checkout-rewrite", lists three transcript chips
  and two plan chips, selecting one of each sends
  `Context attached from Archductor …` with the transcript's user/agent lines
  (the `/model` control row excluded) and the plan body ahead of the typed
  message, while the bubble shows only `📎 <label>` markers.
- Not done: no MCP tools for the three RPCs (MCP exposes a curated subset and
  already omits `list_chat_threads`/`get_chat_projection`), and no GTK surface
  exists in this tree.

## Shell layout rules (added 2026-08-18)

- Three columns: sidebar (min 220), chat (min 360), inspector (min 260) — they
  fit exactly at Electron's 900px minimum window. Side columns are drag-sized
  and remember their width; `lib/panelWidths.ts` caps a drag at what is left
  after the other panel and the chat minimum, and `max-width: min(Xpx, 30vw)`
  keeps a remembered width from overflowing a smaller window.
- `.content-area` and `.ws-center` use `flex-basis: 0`. With `auto` they bid for
  their content width, which squeezed the sidebar and the inspector down to
  their minimums on wide windows.
- The inspector no longer disappears at 1100px (it shrinks instead); the
  breakpoint that hides it now sits at 880px, below the minimum window.
- Chat column order: timeline takes the slack, a pending agent ask is capped at
  45% and scrolls, the composer never shrinks. A long plan card used to push the
  composer off the bottom of a short window.
- The chat tab strip scrolls (it was `overflow: hidden`, which hid every tab
  past the first when the column narrowed) and the new-chat button is pinned
  outside the scroller.
