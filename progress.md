# Progress

Current as of 2026-07-29.

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
- Shell, Codex, and Claude CLI session commands. Cursor is available from GTK
  launch paths where configured, not from the current CLI `session --kind`
  enum.
- Immediate Codex delivery from GTK Ctrl+Enter and CLI `session send`/`archcar
  send --immediate`, using active-turn steer with transparent new-turn fallback.
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
- CI compile gates for native Windows, glibc Linux, musl Linux, and GTK builds
  on Debian, Fedora, Arch, openSUSE, and Alpine families.

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
  `_from_issue`, `_from_pull_request` (Linear source not yet wired). UI:
  Projects "+ Workspace" dialog.
- Workspace lifecycle: `archive`/`restore`/`rename`/`duplicate`/`delete`
  (delete uses the lifecycle job; cleanup failures are logged, row still
  removed). UI: Projects row "⋯" → workspace actions dialog.
- Branch: `create_branch`/`checkout_branch`/`rename_workspace_branch`/
  `delete_branch`/`push_branch`. UI: workspace actions dialog + Checks tab.
- Pull request: `refresh_pull_request`, `merge_pull_request`. UI: Checks tab.
- Review: `add_review_comment`. UI: Review tab.
- Checkpoint: `delete_checkpoint` (alongside existing create/restore). UI:
  Checkpoints tab.
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

Workspace creation from branch/base: the create-workspace dialog gained a
"Branch" source (name + branch + optional base) alongside Prompt and Github,
calling the existing `create_workspace` RPC — restoring the GTK branch/base
creation flow. The base field autocompletes from the repo's local branches via a
new `list_repository_branches` RPC (CLI `archcar branches`).

Timeline: `list_workspace_timeline` RPC (CLI `archcar timeline`) surfaces the
workspace lifecycle events (creation, branch changes, session lifecycle,
PR/check actions, commits, archive, …). Restored as a Timeline right-panel tab
(newest first), matching the GTK Timeline surface.

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
existing `lc-theme-*`/`lc-accent-*`/`lc-density-*` class hooks on `<body>`.

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
(Settings page), and a Cmd/Ctrl+K command palette. Still outstanding: full
visual parity is an ongoing refinement, Linear workspace source is not wired,
and prompt-pack switching / hooks / a local check-runner UI remain unbuilt.

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
  GTK runtime, PTY, provider, upgrade, and checksum smoke remain required
  before calling the package release-ready.
- Linux remains the manually validated primary product target. CI covers GNU
  and musl plus representative distro families; individual package channels
  still require install/launch/upgrade validation.
- Release packaging still needs full manual validation on target distros before
  public launch.

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
CLI, or GTK, say which layer is implemented or verified.

Before calling behavior done, name:

- written tests
- CLI smoke
- GTK smoke

If one layer is skipped, say exactly why.

## Recent Verification

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
- Live permission/question/plan interaction cards in GTK.
- Archcar restart with a pending Claude interaction.
