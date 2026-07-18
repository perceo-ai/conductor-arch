# GTK State Refresh Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate GTK background state sync, workspace/chat navigation state, active chat rendering, and terminal refresh so running generations keep off-focus UI current without rebuilding unrelated surfaces.

**Architecture:** Keep durable truth in core stores and make GTK refreshes explicit outcomes rather than broad `RefreshScope::All` calls. Chat refresh is split into background projection sync, workspace chat-nav/chrome refresh, and active timeline rendering. Terminal gets its own refresh controller and PTY Inspector is removed from GTK.

**Tech Stack:** Rust, GTK4/libadwaita, SQLite-backed `WorkspaceStore`, archcar events, existing `cargo test -p archductor-gtk` unit tests, existing Xvfb GTK smoke.

## Global Constraints

- Do not rewrite GTK architecture wholesale.
- Do not refresh hidden full chat timelines on every provider event.
- Do refresh background running chat/workspace state even when not focused.
- Do keep CLI/core behavior inline when GTK behavior relies on core state.
- Do remove GTK PTY Inspector from product UI.
- Do keep terminal behavior real and refreshed.
- Do not call behavior done without written tests plus relevant CLI and GTK smoke.
- Do not use `RefreshScope::All` for routine runtime/chat/review updates after this cleanup.

---

## End-State Model

Durable state owners:

- `WorkspaceRecord`: workspace name, branch, path, status.
- `ChatThreadRecord`: chat tab title, provider, model/harness metadata, native thread id, status.
- `ChatMessageRecord`: visible user/system/assistant bubbles, context usage, duplicate optimistic input suppression, history transcript content.
- `ProviderEventRecord`: tool/action/reasoning/status cards, provider interaction cards, metadata directives.
- `ProcessRecord`: session lifecycle, process status, readiness proxy, runtime/process summaries.
- PR/check/todo/comment records: review/check surfaces and readiness.

GTK state layers:

- Background sync state: no widgets; tracks active/running work across workspaces and changed thread/workspace summaries.
- Workspace navigation state: chat tab bar, chat title, unread/running badges, workspace title, branch label.
- Active chat timeline state: selected chat message/tool timeline, context usage, composer state, queue overlay, scroll restoration.
- Global summary state: sidebar rows, dashboard cards, history list freshness.
- Terminal state: terminal process list, active shell, transcript buffer, command history/search.

Refresh fanout:

- Chat message appended: background sync + chat nav; active timeline only if visible.
- Chat title changed: chat navbar + history; active timeline unchanged unless selected thread changed.
- Workspace name/branch changed: workspace header + nav state + sidebar + dashboard + navigation state.
- Session started/stopped/turn completed: chat nav + workspace runtime/processes + sidebar + dashboard + history.
- Tool/provider interaction event: active timeline if visible; chat nav only when thread attention/status changes.
- Terminal shell start/stop: terminal + workspace processes/runtime + sidebar + dashboard.
- Terminal command send/output: terminal transcript; broader only if process status changes.

---

### Task 1: Remove Dead Global App State

**Files:**

- Modify: `crates/gtk-app/src/state.rs`
- Verify references in: `crates/gtk-app/src/**/*.rs`

**Interfaces:**

- Consumes: existing `AppStateSnapshot`.
- Produces: smaller `AppStateSnapshot` containing only state that is read by GTK.

Keep fields:

```rust
pub selected_workspace: Option<String>,
pub active_page: AppPage,
pub active_workspace_tab: WorkspaceTab,
pub active_workspace_right_panel_tab: WorkspaceRightPanelTab,
pub selected_chat_thread: Option<i64>,
pub selected_agent_session: Option<i64>,
pub staged_review_prompt: Option<String>,
pub pending_chat_prompt: Option<String>,
navigation_back: Vec<NavigationEntry>,
navigation_forward: Vec<NavigationEntry>,
```

Remove fields:

```rust
pub selected_project: Option<String>,
pub running_processes: Vec<i64>,
pub attention_state: AttentionState,
pub settings_layer: SettingsLayer,
```

- [ ] **Step 1: Confirm no live reads**

Run:

```bash
rg -n "selected_project|running_processes|attention_state|settings_layer|AttentionState|SettingsLayer" crates/gtk-app/src
```

Expected: only definitions/initializers/tests in `state.rs`, plus dashboard-local `selected_project` which must stay.

- [ ] **Step 2: Remove dead fields and dead types**

Delete `AttentionState` and the unused global `SettingsLayer` enum from `state.rs` only if no other GTK file uses them.

- [ ] **Step 3: Update tests**

Remove assertions that mention the removed fields. Keep navigation/chat reset tests intact.

- [ ] **Step 4: Verify**

Run:

```bash
cargo test -p archductor-gtk state
```

Expected: all matching state tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/gtk-app/src/state.rs
git commit -m "refactor(gtk): remove dead app state fields"
```

---

### Task 2: Remove GTK PTY Inspector Surface

**Files:**

- Modify: `crates/gtk-app/src/main.rs`
- Modify: `crates/gtk-app/src/state.rs`
- Modify: `crates/gtk-app/src/sidebar.rs`
- Modify: `crates/gtk-app/src/command_palette.rs`
- Delete: `crates/gtk-app/src/pty_inspector.rs`
- Modify: `docs/manual-testing-checklist.md`
- Modify: `progress.md`

**Interfaces:**

- Consumes: existing debug-only `AppPage::PtyInspector`.
- Produces: no GTK PTY Inspector page, no sidebar item, no command palette entry, no deep link target.

- [ ] **Step 1: Write/adjust tests first**

In `command_palette.rs` tests, replace expectations for `"Session Logs"` with expectations that debug and non-debug command lists both exclude it:

```rust
assert!(commands.iter().all(|command| command.label != "Session Logs"));
```

In `main.rs` deep-link tests, change debug `pty-inspector` behavior to default/fallback error behavior used by unsupported pages.

- [ ] **Step 2: Remove page enum variant**

Delete `AppPage::PtyInspector` and every match arm referencing it.

- [ ] **Step 3: Remove module wiring**

Delete:

```rust
mod pty_inspector;
```

Delete `main_stack.add_named(... "pty-inspector")`.

- [ ] **Step 4: Remove sidebar item and palette command**

Delete debug-only Session Logs nav construction from `sidebar.rs`.

Delete `PaletteTarget::Page(AppPage::PtyInspector)` command from `command_palette.rs`.

- [ ] **Step 5: Delete GTK inspector file**

Delete `crates/gtk-app/src/pty_inspector.rs`.

- [ ] **Step 6: Update docs**

Remove PTY Inspector manual checklist bullets and progress claims. Keep low-level session logs described only as diagnostics/persistence where still true.

- [ ] **Step 7: Verify**

Run:

```bash
cargo test -p archductor-gtk command_palette
cargo test -p archductor-gtk parse_launch_target
cargo test -p archductor-gtk
```

Expected: all pass.

- [ ] **Step 8: GTK smoke**

Run:

```bash
timeout 8 xvfb-run -a target/debug/archductor-gtk --page pty-inspector
```

Expected: app starts or rejects/falls back without a PTY Inspector page. No Session Logs sidebar item.

- [ ] **Step 9: Commit**

```bash
git add crates/gtk-app/src docs/manual-testing-checklist.md progress.md
git commit -m "refactor(gtk): remove pty inspector surface"
```

---

### Task 3: Add Typed GTK Refresh Events

**Files:**

- Modify: `crates/gtk-app/src/refresh.rs`
- Modify call sites in: `crates/gtk-app/src/main.rs`, `sidebar.rs`, `workspace_command_center.rs`, `session_surface.rs`, `terminal.rs`, `projects.rs`, `settings.rs`

**Interfaces:**

Add:

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefreshEvent {
    Manual,
    ProjectInventoryChanged,
    SettingsChanged,
    WorkspaceSelectionChanged,
    WorkspaceInventoryChanged,
    WorkspaceRuntimeChanged { workspace: String },
    WorkspaceReviewChanged { workspace: String },
    WorkspaceChatLifecycleChanged { workspace: String },
    WorkspaceChatMessagesChanged { workspace: String, thread_id: i64 },
    TerminalChanged { workspace: String },
}
```

Add:

```rust
impl RefreshHub {
    pub fn refresh_event(&self, event: RefreshEvent) {
        match event {
            RefreshEvent::Manual => self.refresh(RefreshScope::All),
            RefreshEvent::ProjectInventoryChanged => {
                self.refresh(RefreshScope::Projects);
                self.refresh(RefreshScope::Sidebar);
                self.refresh(RefreshScope::Dashboard);
            }
            RefreshEvent::SettingsChanged => {
                self.refresh(RefreshScope::Projects);
                self.refresh(RefreshScope::Workspace);
            }
            RefreshEvent::WorkspaceSelectionChanged => {
                self.refresh(RefreshScope::Sidebar);
                self.refresh(RefreshScope::Workspace);
            }
            RefreshEvent::WorkspaceInventoryChanged => {
                self.refresh(RefreshScope::Sidebar);
                self.refresh(RefreshScope::Dashboard);
                self.refresh(RefreshScope::History);
                self.refresh(RefreshScope::Workspace);
            }
            RefreshEvent::WorkspaceRuntimeChanged { .. }
            | RefreshEvent::WorkspaceChatLifecycleChanged { .. }
            | RefreshEvent::TerminalChanged { .. } => {
                self.refresh(RefreshScope::Sidebar);
                self.refresh(RefreshScope::Dashboard);
                self.refresh(RefreshScope::History);
                self.refresh(RefreshScope::Workspace);
            }
            RefreshEvent::WorkspaceReviewChanged { .. } => {
                self.refresh(RefreshScope::Dashboard);
                self.refresh(RefreshScope::History);
                self.refresh(RefreshScope::Workspace);
            }
            RefreshEvent::WorkspaceChatMessagesChanged { .. } => {
                self.refresh(RefreshScope::Workspace);
            }
        }
    }
}
```

- [ ] **Step 1: Write tests**

Add tests in `refresh.rs` proving event fanout does not call Projects/Settings for runtime/chat events.

- [ ] **Step 2: Add enum and fanout**

Implement `RefreshEvent` and `refresh_event`.

- [ ] **Step 3: Keep old `refresh(scope)`**

Do not delete `RefreshScope` yet. This keeps the change safe and incremental.

- [ ] **Step 4: Verify**

Run:

```bash
cargo test -p archductor-gtk refresh
```

Expected: refresh tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/gtk-app/src/refresh.rs
git commit -m "feat(gtk): add typed refresh events"
```

---

### Task 4: Add Background Workspace/Chat Sync Model

**Files:**

- Create: `crates/gtk-app/src/background_sync.rs`
- Modify: `crates/gtk-app/src/main.rs`
- Modify: `crates/gtk-app/src/session_surface.rs`

**Interfaces:**

Create:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundThreadSnapshot {
    pub workspace: String,
    pub thread_id: i64,
    pub title: String,
    pub provider: String,
    pub status: String,
    pub latest_message_id: Option<i64>,
    pub latest_provider_sequence: Option<i64>,
    pub running_session_id: Option<i64>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackgroundSyncSnapshot {
    pub running_threads: Vec<BackgroundThreadSnapshot>,
}

pub fn load_background_sync_snapshot(
    db_path: &std::path::Path,
) -> anyhow::Result<BackgroundSyncSnapshot>;

pub fn diff_background_sync(
    previous: &BackgroundSyncSnapshot,
    next: &BackgroundSyncSnapshot,
) -> Vec<RefreshEvent>;
```

Behavior:

- Load only running or recently active sessions/threads.
- Do not load full chat message bodies.
- Include enough ids/sequences to know that nav/global state changed.

- [ ] **Step 1: Write unit tests**

Test pure `diff_background_sync`:

```rust
let previous = BackgroundSyncSnapshot::default();
let next = BackgroundSyncSnapshot {
    running_threads: vec![BackgroundThreadSnapshot {
        workspace: "berlin".into(),
        thread_id: 7,
        title: "Fix auth".into(),
        provider: "codex".into(),
        status: "running".into(),
        latest_message_id: Some(11),
        latest_provider_sequence: Some(99),
        running_session_id: Some(22),
        updated_at: "2026-07-18T12:00:00Z".into(),
    }],
};
let events = diff_background_sync(&previous, &next);
assert!(events.contains(&RefreshEvent::WorkspaceChatLifecycleChanged {
    workspace: "berlin".into(),
}));
```

- [ ] **Step 2: Implement pure diff first**

Map:

- new/removed running session -> `WorkspaceChatLifecycleChanged`
- latest message/provider sequence change -> `WorkspaceChatMessagesChanged`
- title/status/provider change -> `WorkspaceChatLifecycleChanged`

- [ ] **Step 3: Implement store loader**

Use existing `WorkspaceStore` queries. If needed, add narrow core query in `crates/core/src/workspace.rs` instead of scanning full timelines.

- [ ] **Step 4: Wire timer in `main.rs`**

Add a 1s or 2s timer that:

- loads background snapshot
- diffs against previous
- calls `refresh_hub.refresh_event(event)` for each event

Guard:

- only run when there are running sessions
- do not call `RefreshScope::All`

- [ ] **Step 5: Verify**

Run:

```bash
cargo test -p archductor-gtk background_sync
cargo test -p archductor-gtk refresh
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add crates/gtk-app/src/background_sync.rs crates/gtk-app/src/main.rs crates/gtk-app/src/session_surface.rs
git commit -m "feat(gtk): sync running chat state in background"
```

---

### Task 5: Split Chat Nav/Chrome Refresh From Active Timeline Refresh

**Files:**

- Modify: `crates/gtk-app/src/workspace_command_center.rs`
- Modify: `crates/gtk-app/src/session_surface.rs`

**Interfaces:**

Add in `session_surface.rs`:

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ChatRefreshOutcome {
    pub messages_changed: bool,
    pub thread_title_changed: bool,
    pub workspace_name_changed: bool,
    pub branch_changed: bool,
    pub session_lifecycle_changed: bool,
    pub provider_controls_changed: bool,
    pub composer_state_changed: bool,
}
```

Change local refresh controller shape:

```rust
type RefreshChatSurfaceController = Rc<RefCell<Option<Rc<dyn Fn() -> ChatRefreshOutcome>>>>;
```

If changing the controller return type is too invasive, keep the controller as `Fn()` and add a second `last_chat_refresh_outcome: Rc<RefCell<ChatRefreshOutcome>>`. Prefer return type if the compiler impact is small.

- [ ] **Step 1: Add tests for chat nav refresh intent**

In `workspace_command_center.rs`, add a unit test for pure helper:

```rust
fn chat_outcome_requires_nav_refresh(outcome: &ChatRefreshOutcome) -> bool {
    outcome.thread_title_changed
        || outcome.workspace_name_changed
        || outcome.branch_changed
        || outcome.session_lifecycle_changed
}
```

Expected:

- message-only outcome returns false for workspace chrome/global summary.
- title/workspace/branch/session lifecycle returns true.

- [ ] **Step 2: Add outcome struct**

Initialize default outcome at the top of chat refresh.

- [ ] **Step 3: Set outcome flags**

Set:

- `thread_title_changed` when `apply_agent_metadata_ui_update` changes thread title.
- `workspace_name_changed` when metadata changes workspace name.
- `branch_changed` when metadata changes branch.
- `session_lifecycle_changed` for archcar started/exited/turn completed/error events.
- `messages_changed` when latest messages/provider events signature changed.
- `provider_controls_changed` when selected provider/model/thinking controls change.
- `composer_state_changed` when send button/placeholder/queue overlay changes.

- [ ] **Step 4: Workspace center consumes outcome**

When chat refresh reports nav/chrome changes:

- rerender chat tabs with `on_threads_changed`
- update branch label
- update workspace title if header exists
- call `RefreshEvent::WorkspaceChatLifecycleChanged` only for session lifecycle/workspace rename/branch changes

- [ ] **Step 5: Stop rebuilding workspace on chat tab selection**

Replace tab select/close/reopen/new-chat `RefreshScope::Workspace` calls with local:

- update `selected_thread`
- call external selection controller
- rerender tab strip
- call active chat refresh only

- [ ] **Step 6: Verify**

Run:

```bash
cargo test -p archductor-gtk chat_refresh
cargo test -p archductor-gtk workspace_chat
```

Expected: queue overlay stability tests still pass; chat stale-surface tests still pass.

- [ ] **Step 7: Commit**

```bash
git add crates/gtk-app/src/session_surface.rs crates/gtk-app/src/workspace_command_center.rs
git commit -m "refactor(gtk): split chat nav refresh from timeline refresh"
```

---

### Task 6: Wire Archcar Events To Background/Nav Outcomes

**Files:**

- Modify: `crates/gtk-app/src/session_surface.rs`
- Modify: `crates/gtk-app/src/archcar_async.rs` only if wake metadata needs to be exposed.

**Interfaces:**

Use existing:

```rust
fn archcar_message_refresh_scope(message: &AsyncArchcarMessage) -> (bool, bool)
```

Replace tuple with named type:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ArchcarRefreshIntent {
    chat_surface: bool,
    workspace_nav: bool,
    global_summary: bool,
}
```

Mapping:

- `SessionReady`, `SessionCapabilitiesChanged`, `SessionScreenUpdated`, `SessionMessagesUpdated`, provider interaction events -> chat surface.
- `SessionSpawnQueued`, `SessionStarted`, `TurnCompleted`, `SessionExited`, `SessionError` -> chat surface + workspace nav + global summary.
- response ack/error -> chat surface only unless it starts/stops a session.
- bridge error -> chat surface; global summary only if session lifecycle becomes errored.

- [ ] **Step 1: Rename tests**

Replace tuple tests with named intent tests.

- [ ] **Step 2: Use intent in wake path**

When draining archcar messages inside chat refresh, aggregate intent into `ChatRefreshOutcome`.

- [ ] **Step 3: Background sync catches off-focus events**

Because off-focus surfaces may not be mounted, rely on Task 4 timer to process persisted archcar/core state and update nav/global summary.

- [ ] **Step 4: Verify**

Run:

```bash
cargo test -p archductor-gtk archcar_message_refresh
cargo test -p archductor-gtk provider_interaction_events_refresh_thread_only
```

Expected: provider interactions do not force global summary refresh; lifecycle events do.

- [ ] **Step 5: Commit**

```bash
git add crates/gtk-app/src/session_surface.rs crates/gtk-app/src/archcar_async.rs
git commit -m "refactor(gtk): route archcar refresh intent explicitly"
```

---

### Task 7: Terminal Refresh Controller

**Files:**

- Modify: `crates/gtk-app/src/terminal.rs`
- Modify: `crates/gtk-app/src/workspace_command_center.rs`
- Modify: `crates/gtk-app/src/refresh.rs`

**Interfaces:**

Add in `terminal.rs`:

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TerminalRefreshOutcome {
    pub process_changed: bool,
    pub transcript_changed: bool,
}

type RefreshTerminalSurface = Rc<dyn Fn() -> TerminalRefreshOutcome>;
```

`embedded_terminal_panel` should create a local refresh closure that:

- reloads latest terminal process list
- reloads latest transcript tail for active shell
- updates transcript buffer only when content changed
- returns outcome

- [ ] **Step 1: Write tests for terminal scope**

Keep and expand existing `terminal_process_refresh_scope` test or replace with outcome tests:

```rust
assert_eq!(
    terminal_refresh_event("berlin", TerminalRefreshOutcome {
        process_changed: true,
        transcript_changed: false,
    }),
    Some(RefreshEvent::TerminalChanged { workspace: "berlin".into() })
);
```

- [ ] **Step 2: Implement local refresh closure**

Store last transcript hash and last process ids/statuses in local `Rc<RefCell<_>>`.

- [ ] **Step 3: Call refresh after terminal actions**

After start/stop/resize/send:

- append immediate local status text
- request archcar action
- call local terminal refresh
- if `process_changed`, call `RefreshEvent::TerminalChanged`

- [ ] **Step 4: Update workspace command center**

Pass `RefreshHub` through to terminal and call typed events instead of unused `_refresh_hub`.

- [ ] **Step 5: Verify**

Run:

```bash
cargo test -p archductor-gtk terminal
cargo test -p archductor-gtk refresh
```

Expected: terminal tests pass.

- [ ] **Step 6: CLI smoke**

Run:

```bash
cargo run -p archductor -- doctor
```

Expected: doctor runs; no CLI regression from shared state changes.

- [ ] **Step 7: Commit**

```bash
git add crates/gtk-app/src/terminal.rs crates/gtk-app/src/workspace_command_center.rs crates/gtk-app/src/refresh.rs
git commit -m "fix(gtk): refresh terminal state after shell actions"
```

---

### Task 8: Replace Broad `RefreshScope::All` Clusters

**Files:**

- Modify: `crates/gtk-app/src/main.rs`
- Modify: `crates/gtk-app/src/sidebar.rs`
- Modify: `crates/gtk-app/src/workspace_command_center.rs`
- Modify: `crates/gtk-app/src/projects.rs`

**Interfaces:**

Use `refresh_hub.refresh_event(...)` for routine changes.

Allowed remaining `RefreshScope::All`:

- explicit manual refresh shortcut
- command palette Refresh
- startup fallback immediately after startup runtime reconciliation reports changed persisted state

Disallowed routine `All`:

- setup/run/stop/Spotlight
- archive/restore/delete/rename/duplicate
- PR refresh/create/merge/check actions
- review comment/todo actions
- open conflict workspace
- background runtime timer

- [ ] **Step 1: Add source guard test**

Add a test that scans source for known disallowed `RefreshScope::All` clusters, similar existing source-structure tests in `session_surface.rs`.

- [ ] **Step 2: Runtime actions**

Map:

- setup/run/stop/Spotlight -> `WorkspaceRuntimeChanged { workspace }`

- [ ] **Step 3: Lifecycle actions**

Map:

- rename/duplicate/archive/restore/discard/delete -> `WorkspaceInventoryChanged`

- [ ] **Step 4: Review/PR/check/todo actions**

Map:

- PR create/refresh/merge/check comments -> `WorkspaceReviewChanged { workspace }`
- local review/todo/comment changes -> `WorkspaceReviewChanged { workspace }`

- [ ] **Step 5: Runtime reconciliation timer**

Map timer changes to `WorkspaceRuntimeChanged` for selected/running workspaces, not `All`.

- [ ] **Step 6: Verify**

Run:

```bash
cargo test -p archductor-gtk refresh
cargo test -p archductor-gtk workspace_command_center
cargo test -p archductor-gtk sidebar
```

Expected: all pass and guard test prevents routine `All`.

- [ ] **Step 7: Commit**

```bash
git add crates/gtk-app/src/main.rs crates/gtk-app/src/sidebar.rs crates/gtk-app/src/workspace_command_center.rs crates/gtk-app/src/projects.rs
git commit -m "refactor(gtk): replace broad refreshes with typed events"
```

---

### Task 9: Workspace Chat Navbar Background Updates

**Files:**

- Modify: `crates/gtk-app/src/workspace_command_center.rs`
- Modify: `crates/gtk-app/src/background_sync.rs`

**Interfaces:**

Add workspace nav projection:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceChatNavItem {
    pub thread_id: i64,
    pub title: String,
    pub provider: String,
    pub status: String,
    pub running: bool,
    pub unread: bool,
    pub updated_at: String,
}
```

Add loader:

```rust
pub(crate) fn load_workspace_chat_nav(
    db_path: &Path,
    workspace: &str,
    selected_thread: Option<i64>,
) -> anyhow::Result<Vec<WorkspaceChatNavItem>>;
```

- [ ] **Step 1: Write pure nav tests**

Test selected thread is never marked unread; changed non-selected running thread is unread/running.

- [ ] **Step 2: Load nav from store**

Use thread records, process records, latest message/provider event ids. Do not load full message bodies.

- [ ] **Step 3: Rerender chat navbar from projection**

Chat tabs should show:

- title
- provider/status styling
- running indicator
- unread/updated mark for background changed thread

- [ ] **Step 4: Background event updates nav**

When `WorkspaceChatMessagesChanged` arrives for selected workspace, refresh chat navbar even if the changed thread is not selected.

- [ ] **Step 5: Verify**

Run:

```bash
cargo test -p archductor-gtk workspace_chat_nav
cargo test -p archductor-gtk background_sync
```

Expected: off-selected thread changes update nav projection without timeline render.

- [ ] **Step 6: Commit**

```bash
git add crates/gtk-app/src/workspace_command_center.rs crates/gtk-app/src/background_sync.rs
git commit -m "feat(gtk): refresh chat navbar for background threads"
```

---

### Task 10: Final Verification And Docs

**Files:**

- Modify: `docs/manual-testing-checklist.md`
- Modify: `progress.md`
- Modify: `README.md` only if user-visible behavior descriptions changed.

**Verification commands:**

```bash
cargo fmt --all -- --check
cargo clippy -p archductor-core -p archductor -p archductor-gtk --all-targets -- -D warnings
cargo test -p archductor-core
cargo test -p archductor
cargo test -p archductor-gtk
cargo build -p archductor-gtk
cargo run -p archductor -- doctor
timeout 8 xvfb-run -a target/debug/archductor-gtk
```

**Manual GTK smoke checklist:**

- Start one Codex/Claude session in workspace A.
- Switch to workspace B while A is generating.
- Confirm sidebar/dashboard show A running.
- Return to workspace A and confirm chat title/nav/timeline catches up.
- Start two chat threads in one workspace.
- Generate in thread 1, select thread 2.
- Confirm chat navbar shows thread 1 running/unread while thread 2 timeline remains stable.
- Stop terminal shell and confirm terminal + process panel + dashboard/sidebar update.
- Confirm no Session Logs/PTY Inspector page appears with or without `ARCHDUCTOR_DEBUG`.

- [ ] **Step 1: Update docs**

Record PTY Inspector removal and new refresh behavior in `progress.md` and checklist.

- [ ] **Step 2: Run full verification**

Run every command above and capture failures exactly.

- [ ] **Step 3: Commit docs/final cleanup**

```bash
git add docs/manual-testing-checklist.md progress.md README.md
git commit -m "docs: update gtk refresh cleanup status"
```

---

## Risk Controls

- Keep chat token/message streaming local.
- Never make background sync load full timelines for all workspaces.
- Prefer ids/sequences/hashes for background change detection.
- Keep `RefreshScope::All` available only for explicit manual refresh until all typed events are stable.
- Each task lands independently with tests.
- If a task requires broad rewrites in `workspace_command_center.rs` or `session_surface.rs`, stop and split the file first only around the active code path.

## Expected Final State

- Running generations update background workspace/chat state even when not focused.
- Off-selected chat changes update chat navbar/title/status without rendering that full timeline.
- Selected chat timeline remains fast and stable.
- Workspace title/branch/chat title update from persisted metadata directives.
- Terminal shell lifecycle refreshes terminal and surrounding runtime UI.
- PTY Inspector is gone from GTK.
- Dead global app state is removed.
- Routine GTK actions no longer use `RefreshScope::All`.
