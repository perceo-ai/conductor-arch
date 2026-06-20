# Linux Conductor Manual Testing Checklist

Use this checklist before calling the app flow healthy or cutting a public
artifact. It focuses on the real Conductor loop: one repository, many
workspaces, multiple agent sessions, review, GitHub PR, merge, archive, repeat.

Run on a machine with `git`, `gh`, Rust, GTK4, libadwaita, and any agent CLIs
you want to test. Run `gh auth login` before GitHub checks. Set
`LINEAR_API_KEY` before Linear checks.

## Build And Launch

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo test -p linux-conductor-core -p linux-conductor -p linux-conductor-gtk`
- [ ] `cargo build --workspace --release --locked`
- [ ] `./target/release/linux-conductor doctor` prints distro guidance.
- [ ] `./target/release/linux-conductor-gtk` opens the GTK app.

## Repository Setup

- [ ] Add an existing local repository from the Projects page.
- [ ] Clone a Git repository from the Projects page.
- [ ] Confirm the repository row shows path, remote/default branch metadata, and
  workspace parent.
- [ ] Edit shared `.conductor/settings.toml` from Projects.
- [ ] Edit local `.conductor/settings.local.toml` from Projects.
- [ ] Configure setup, run, archive, run mode, Spotlight testing, Files to copy,
  environment variables, provider executable fields, prompts, and Git behavior.
- [ ] Confirm `.worktreeinclude` wins over Files to copy settings and is shown
  as a read-only preview when present.
- [ ] Confirm shared settings do not encourage committing secrets.

## Workspace Creation

- [ ] Create a branch/base workspace from the GUI.
- [ ] Create a prompt workspace and confirm `.context/brief.md` contains the
  prompt.
- [ ] Create a GitHub issue workspace with authenticated `gh`.
- [ ] Create a GitHub PR workspace with authenticated `gh`; confirm the PR head
  ref is fetched before the worktree is created.
- [ ] Confirm GitHub source creation fails clearly when `gh auth status` is not
  authenticated.
- [ ] Create a Linear issue workspace with `LINEAR_API_KEY`.
- [ ] Confirm Linear source creation fails clearly without `LINEAR_API_KEY`.
- [ ] Confirm each workspace maps to one branch and one Git worktree.
- [ ] Confirm each workspace has `.context/brief.md`, `.context/agent-notes.md`,
  and `.context/todos.md`.
- [ ] Confirm two workspaces in the same repository receive different
  `CONDUCTOR_PORT` ranges.
- [ ] Confirm branch/worktree conflicts are surfaced clearly.

## Agent Sessions And Terminal

- [ ] Start Shell, Codex, Claude Code, and Cursor sessions from the workspace
  page.
- [ ] Confirm sessions run from the workspace directory with `CONDUCTOR_*`
  environment variables.
- [ ] Start multiple sessions in one workspace.
- [ ] Start sessions in two workspaces for the same repository.
- [ ] Send input to a selected live session.
- [ ] Stage a review/check/comment prompt and send it to the selected session.
- [ ] Stop the selected session and confirm the process row updates.
- [ ] Confirm Plan/Fast mode and Codex harness controls affect new sessions.
- [ ] Confirm provider/auth/MCP status text appears where applicable.
- [ ] Run a one-shot terminal command and confirm stdout, stderr, and exit code.
- [ ] Start multiple PTY shells, select one, send input to it, and stop only
  that shell.
- [ ] Confirm stopped/exited terminal process rows reconcile after restart.
- [ ] Confirm terminal transcripts are persisted, searchable, and reloadable.

## Runtime

- [ ] Run setup from the workspace page and confirm logs/process status.
- [ ] Run the app script and confirm logs/process status.
- [ ] Stop the run script and confirm exit status.
- [ ] Confirm `scripts.run_mode = "concurrent"` allows two workspace run scripts
  in one repository.
- [ ] Confirm `scripts.run_mode = "nonconcurrent"` blocks a second run script in
  the same repository.
- [ ] With `spotlight_testing = true`, confirm Spotlight On applies tracked
  workspace changes to a clean repository root.
- [ ] Confirm Spotlight Sync updates the active root patch after tracked
  workspace edits.
- [ ] Confirm Spotlight Off restores the root.
- [ ] Confirm root-only edits block Spotlight Off/Sync until repaired or cleaned.
- [ ] Confirm Repair Spotlight discards root-only edits and reapplies the active
  workspace patch only after explicit user action.

## Review And Merge

- [ ] Make a small change in a workspace.
- [ ] Confirm Changes shows git status, recent commits, changed-file list,
  additions/deletions, and a file diff.
- [ ] Add a local review comment.
- [ ] Resolve a local review comment.
- [ ] Revert a tracked changed file from the UI.
- [ ] Confirm unsafe untracked-file revert attempts fail visibly.
- [ ] Create two workspaces that edit the same file and confirm sibling
  conflict detection.
- [ ] Copy or inspect conflicting sibling files from the conflict panel.
- [ ] Add and complete todos from the GUI.
- [ ] Create a PR from the Checks tab.
- [ ] Refresh PR state.
- [ ] View raw PR checks.
- [ ] Stage failing PR checks for the selected agent.
- [ ] View raw PR comments/reviews.
- [ ] Stage PR comments/reviews for the selected agent.
- [ ] Confirm merge is blocked by open todos or open local review comments.
- [ ] Merge the PR with squash, merge, or rebase.
- [ ] Confirm `archive_on_merge = true` archives after merge.
- [ ] Archive, restore, rename, and discard workspaces from the GUI.
- [ ] Repeat the create-work-review-merge-archive loop for the same repository.

## History And Navigation

- [ ] Sidebar search finds repositories and workspaces.
- [ ] Dashboard groups active and archived workspaces.
- [ ] History shows archived workspaces.
- [ ] History reads old macOS Conductor chats when
  `~/Library/Application Support/com.conductor.app/conductor.db` exists.
- [ ] `Ctrl+R` refreshes the visible workspace state.

## Known Gaps To Keep Visible

- [ ] Agent chat is still PTY/transcript-oriented, not a polished structured
  message UI with attachments.
- [ ] Terminal rendering is not a full terminal emulator.
- [ ] Command palette, broad shortcuts, and deep links are not complete.
- [ ] Monorepo directory selection and linked-directory workflows are not
  complete.
- [ ] GitHub review-thread sync and deployment/check aggregation are still raw.
- [ ] Unified local history for all chats is not complete.
- [ ] Visual parity with Conductor is not complete.

## Packaging Smoke

- [ ] `VERSION=0.1.0 nfpm package --packager deb --target dist/`
- [ ] `VERSION=0.1.0 nfpm package --packager rpm --target dist/`
- [ ] AppImage launches GUI with no args:
  `./dist/linux-conductor-0.1.0-x86_64.AppImage`
- [ ] AppImage forwards CLI args:
  `./dist/linux-conductor-0.1.0-x86_64.AppImage doctor`
- [ ] Flatpak build status is documented if it fails because of sandbox or
  dependency limitations.
