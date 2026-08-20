use anyhow::{Context, Result};
use archductor_core::archcar::client::{
    configured_remote_endpoint, ArchcarClient, ArchcarEndpoint,
};
use archductor_core::archcar::harness_contract::{
    InteractionAnswer, ProviderInteractionResolution,
};
use archductor_core::archcar::protocol::{
    ArchcarInputDelivery, ArchcarInputKind, ArchcarMessage, ArchcarRequest, ArchcarResponse,
    QueuedArchcarInput, WorkspaceChangeScope, WorkspaceGitAction,
};
use archductor_core::archcar::remote;
use archductor_core::archcar::server::{reconcile_managed_sessions_on_startup, ArchcarServer};
use archductor_core::background_tasks::{BackgroundAgentSpec, StartBackgroundTask};
use archductor_core::doctor;
use archductor_core::import::{default_conductor_app_database, import_conductor_app_database};
use archductor_core::paths::AppPaths;
use archductor_core::provider_adapters::claude_hooks::handle_claude_hook_json;
use archductor_core::provider_interactions::ProviderInteractionRecord;
use archductor_core::repository::{AddRepository, RepositoryStore};
use archductor_core::service;
use archductor_core::settings::{
    app_shared_settings_to_toml, save_app_shared_settings_from_toml,
    save_repository_settings_from_toml, SettingsLayer,
};
use archductor_core::workspace::{
    CreateWorkspace, LinkedDirectory, LocalChatHistoryMessage, LocalChatHistorySummary,
    ProcessRecord, ProcessStatus, SessionHarnessOptions, SessionKind, SessionLaunch,
    WorkspaceStatusLine, WorkspaceStore, WorkspaceTimelineEvent,
};
use archductor_core::workspace_intel::TaskUpdate;
use clap::{Parser, Subcommand, ValueEnum};
use std::collections::HashSet;
use std::fs;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Parser)]
#[command(name = "archductor")]
#[command(about = "Archductor Git worktree workflow for parallel coding agents")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Doctor,
    /// Probe host setup readiness (GitHub CLI + agent providers). Mirrors the
    /// desktop first-run setup gate.
    Setup {
        /// Refresh the process environment before probing so a just-installed
        /// tool is picked up.
        #[arg(long)]
        recheck: bool,
    },
    Settings {
        #[command(subcommand)]
        command: AppSettingsCommand,
    },
    Repo {
        #[command(subcommand)]
        command: RepoCommand,
    },
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
    Run {
        workspace: String,
    },
    Stop {
        workspace: String,
    },
    Logs {
        workspace: String,
        #[arg(long)]
        run: bool,
        #[arg(long)]
        session: bool,
    },
    Runs {
        workspace: String,
    },
    Diff {
        workspace: String,
        #[arg(long)]
        name_only: bool,
        #[arg(long)]
        file: Option<PathBuf>,
        /// Include staged changes too, diffing everything against HEAD
        /// (default: unstaged only).
        #[arg(long)]
        uncommitted: bool,
        /// Diff one commit's changes. Takes precedence over --uncommitted.
        #[arg(long, value_name = "SHA")]
        commit: Option<String>,
    },
    Pr {
        #[command(subcommand)]
        command: PrCommand,
    },
    Session {
        #[command(subcommand)]
        command: SessionCommand,
    },
    Todo {
        #[command(subcommand)]
        command: TodoCommand,
    },
    Checks {
        workspace: String,
    },
    Open {
        workspace: String,
        #[arg(long, default_value = "code")]
        editor: String,
    },
    Mcp {
        #[command(subcommand)]
        command: McpCommand,
    },
    Review {
        #[command(subcommand)]
        command: ReviewCommand,
    },
    Archive {
        name: String,
        #[arg(long)]
        remove_worktree: bool,
    },
    Status,
    Checkpoint {
        #[command(subcommand)]
        command: CheckpointCommand,
    },
    Conflicts {
        workspace: String,
    },
    Discard {
        name: String,
    },
    Import {
        #[command(subcommand)]
        command: ImportCommand,
    },
    History {
        #[command(subcommand)]
        command: HistoryCommand,
    },
    Archcar {
        #[command(subcommand)]
        command: ArchcarCommand,
    },
    /// Manage the archcar background service (launchd / systemd).
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
    /// Point this machine's Archductor clients at a server-hosted daemon.
    Remote {
        #[command(subcommand)]
        command: RemoteCommand,
    },
}

#[derive(Debug, Subcommand)]
enum RemoteCommand {
    /// Save a remote daemon as a client and switch to it (verifies it responds).
    Connect {
        /// `host:port` of the remote archcar TCP listener.
        address: String,
        /// Access token (print it on the server with `archductor service token`).
        #[arg(long)]
        token: String,
        /// Name for this client in the switcher; defaults to the address.
        #[arg(long)]
        label: Option<String>,
        /// Save the client without contacting the daemon.
        #[arg(long)]
        no_verify: bool,
    },
    /// List the saved clients, marking the active one.
    List,
    /// Switch to a saved client by name or id.
    Use {
        /// Client name or id; `local` or `this-machine` selects the local daemon.
        client: String,
        /// Switch without contacting the daemon first.
        #[arg(long)]
        no_verify: bool,
    },
    /// Forget a saved client.
    Remove {
        /// Client name or id.
        client: String,
    },
    /// Show where archcar requests from this machine currently go.
    Status,
    /// Switch back to this machine's local daemon (saved clients are kept).
    Disconnect,
}

#[derive(Debug, Subcommand)]
enum AppSettingsCommand {
    Export {
        #[arg(long)]
        output: PathBuf,
    },
    Import {
        input: PathBuf,
    },
}

#[derive(Debug, Subcommand)]
enum ImportCommand {
    Conductor {
        #[arg(long)]
        source: Option<PathBuf>,
    },
}

#[derive(Debug, Subcommand)]
enum HistoryCommand {
    List {
        #[arg(long)]
        workspace: Option<String>,
    },
    Show {
        process_id: i64,
    },
}

#[derive(Debug, Subcommand)]
enum ArchcarCommand {
    Ensure {
        workspace: String,
        #[arg(long, value_parser = session_kind_parser(), default_value = "codex")]
        kind: SessionKind,
    },
    Spawn {
        workspace: String,
        #[arg(long, value_parser = session_kind_parser(), default_value = "shell")]
        kind: SessionKind,
    },
    Status {
        session_id: i64,
    },
    Screen {
        session_id: i64,
    },
    Messages {
        thread_id: i64,
    },
    Queue {
        #[command(subcommand)]
        command: ArchcarQueueCommand,
    },
    Interactions {
        #[command(subcommand)]
        command: ArchcarInteractionsCommand,
    },
    Send {
        session_id: i64,
        #[arg(long, value_enum, default_value_t = CliArchcarInputKind::User)]
        kind: CliArchcarInputKind,
        #[arg(long)]
        visible_input: Option<String>,
        #[arg(
            long,
            help = "Deliver now: steer an active agent turn or start a new turn"
        )]
        immediate: bool,
        input: Vec<String>,
    },
    Model {
        session_id: i64,
        model: String,
    },
    Effort {
        session_id: i64,
        level: String,
    },
    Fast {
        session_id: i64,
        #[arg(long)]
        off: bool,
    },
    PermissionMode {
        session_id: i64,
        mode: String,
    },
    Interrupt {
        session_id: i64,
    },
    Resize {
        session_id: i64,
        rows: u16,
        cols: u16,
    },
    Kill {
        session_id: i64,
    },
    /// Put a chat into or out of plan mode (agent researches and proposes
    /// instead of building).
    PlanMode {
        thread_id: i64,
        #[arg(long, conflicts_with = "off")]
        on: bool,
        #[arg(long)]
        off: bool,
    },
    /// Show the plan a chat is working from.
    Plan {
        thread_id: i64,
    },
    /// List all workspaces with status counts.
    Workspaces,
    /// List repositories, workspaces, and active chat strips in one request.
    InventorySnapshot,
    /// List repositories with workspace counts.
    Repositories,
    /// Register a git repository with the daemon (paths resolve on the daemon's
    /// machine, so this works against a remote where `repo add` cannot).
    AddRepository {
        /// Path to an existing git repository, on the daemon's filesystem.
        path: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        remote_name: Option<String>,
        #[arg(long)]
        default_branch: Option<String>,
        #[arg(long)]
        workspace_parent: Option<String>,
    },
    /// Create a workspace (worktree + branch) on the daemon.
    CreateWorkspace {
        repository: String,
        name: String,
        branch: String,
        #[arg(long)]
        base_ref: Option<String>,
    },
    /// List chat threads for a workspace.
    ChatThreads {
        workspace: String,
    },
    /// Print the projected chat timeline for a thread.
    ChatProjection {
        thread_id: i64,
    },
    /// List recent non-empty chats offered as attachable transcripts.
    ChatTranscripts {
        workspace: String,
        #[arg(long)]
        limit: Option<usize>,
    },
    /// Print one chat's user/agent transcript (no tool calls).
    ChatTranscript {
        thread_id: i64,
    },
    /// List plan markdown saved under the workspace's .context/plans/.
    ContextPlans {
        workspace: String,
    },
    /// List files in a workspace checkout (for the file browser).
    WorkspaceFiles {
        workspace: String,
    },
    /// Start the workspace's configured run script.
    RunScript {
        workspace: String,
    },
    /// Stop the workspace's running run process.
    StopScript {
        workspace: String,
    },
    /// Print the latest run-script log for a workspace.
    RunLog {
        workspace: String,
    },
    /// Print a workspace's timeline events.
    Timeline {
        workspace: String,
    },
    /// Print sibling workspaces that conflict with this one.
    Conflicts {
        workspace: String,
    },
    /// Print directories linked into a workspace.
    LinkedDirs {
        workspace: String,
    },
    /// Print recent commits for a workspace.
    Commits {
        workspace: String,
        #[arg(long)]
        limit: Option<u32>,
    },
    /// Print a heuristic draft commit message for a workspace.
    CommitDraft {
        workspace: String,
    },
    /// Show a single commit's stat + patch for a workspace.
    CommitDiff {
        workspace: String,
        commit: String,
        /// Limit the patch to one file.
        #[arg(long)]
        path: Option<String>,
    },
    /// List a workspace's configured check commands.
    CheckList {
        workspace: String,
    },
    /// Run one configured check (by key) for a workspace.
    RunCheck {
        workspace: String,
        key: String,
    },
    /// Print the latest check-process log for a workspace.
    CheckLog {
        workspace: String,
    },
    /// Commit a workspace's changes (optionally staging all first).
    Commit {
        workspace: String,
        message: String,
        #[arg(long)]
        stage_all: bool,
    },
    /// Create a workspace from a Linear issue (needs LINEAR_API_KEY).
    CreateFromLinear {
        repository: String,
        issue: String,
    },
    /// Print GitHub PR readiness detail (gh pr view) for a workspace.
    PrReadiness {
        workspace: String,
    },
    /// Print the prompt-pack-resolved agent prompt for a workspace Git action.
    GitActionPrompt {
        workspace: String,
        #[arg(long, value_enum)]
        action: CliWorkspaceGitAction,
    },
    /// Show spotlight-testing status for a workspace.
    SpotlightStatus {
        workspace: String,
    },
    /// Start spotlight testing for a workspace.
    SpotlightStart {
        workspace: String,
    },
    /// Stop spotlight testing for a workspace.
    SpotlightStop {
        workspace: String,
    },
    /// Read a UTF-8 text file from a workspace checkout.
    ReadFile {
        workspace: String,
        path: String,
    },
    /// Overwrite a text file in a workspace checkout with stdin content.
    WriteFile {
        workspace: String,
        path: String,
        /// Inline content (if omitted, read from stdin).
        content: Option<String>,
    },
    /// List changed-file summaries for a workspace.
    WorkspaceChanges {
        workspace: String,
        /// Show all changes vs the review base (default: uncommitted only).
        #[arg(long)]
        all: bool,
        /// Show one commit's changes instead. Takes precedence over --all.
        #[arg(long, value_name = "SHA")]
        commit: Option<String>,
    },
    /// Print the unified diff for a workspace, or for one file in it.
    WorkspaceDiff {
        workspace: String,
        path: Option<String>,
        /// Diff uncommitted changes only (default: everything vs the review base).
        #[arg(long)]
        uncommitted: bool,
        /// Diff one commit's changes. Takes precedence over --uncommitted.
        #[arg(long, value_name = "SHA")]
        commit: Option<String>,
    },
    /// List todos for a workspace.
    Todos {
        workspace: String,
    },
    /// Add a todo to a workspace.
    AddTodo {
        workspace: String,
        text: String,
    },
    /// List checkpoints for a workspace.
    Checkpoints {
        workspace: String,
    },
    /// Create a checkpoint in a workspace.
    CreateCheckpoint {
        workspace: String,
        message: String,
    },
    /// Restore a workspace to a checkpoint.
    RestoreCheckpoint {
        workspace: String,
        checkpoint_id: i64,
    },
    /// Diff a checkpoint against the current working tree.
    CheckpointDiff {
        workspace: String,
        checkpoint_id: i64,
    },
    /// Print the processes text (setups/runs/checks/sessions) for a workspace.
    Processes {
        workspace: String,
    },
    /// List review comments for a workspace.
    Review {
        workspace: String,
    },
    /// Print the DB-only checks summary for a workspace.
    Checks {
        workspace: String,
    },
    /// Print effective settings as JSON (global, or --repository <name>).
    Settings {
        #[arg(long)]
        repository: Option<String>,
    },
    /// Read one settings layer's raw editable source TOML.
    SettingsSource {
        #[arg(long)]
        repository: Option<String>,
        #[arg(long)]
        layer: Option<String>,
    },
    /// List a repository's local branches.
    Branches {
        repository: String,
    },
    /// List every agent this build knows and how completely it drives each.
    Providers,
    /// List a repository's available prompt packs and the active one.
    PromptPacks {
        repository: String,
    },
    /// Set a repository's active prompt pack.
    SetPromptPack {
        repository: String,
        pack: String,
    },
    /// Overwrite one settings layer's source TOML from stdin (or --content).
    SaveSettings {
        #[arg(long)]
        repository: Option<String>,
        #[arg(long)]
        layer: Option<String>,
        #[arg(long)]
        content: Option<String>,
    },
    /// Re-run pending workspace lifecycle recovery jobs.
    RecoverWorkspaceLifecycleJobs,
    /// Create a new chat thread in a workspace.
    CreateChat {
        workspace: String,
        #[arg(long, default_value = "codex")]
        provider: String,
        #[arg(long, default_value = "New chat")]
        title: String,
    },
    /// Close (archive) a chat thread.
    CloseChat {
        thread_id: i64,
    },
    /// Reopen a closed chat thread.
    ReopenChat {
        thread_id: i64,
    },
    /// Start a background development task (creates a workspace, runs an agent).
    StartBackgroundTask {
        repository: String,
        prompt: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        branch: Option<String>,
        #[arg(long)]
        base: Option<String>,
        #[arg(long, default_value = "codex")]
        provider: String,
        /// Skip the repository's configured checks when the agent goes idle.
        #[arg(long)]
        no_checks: bool,
        /// Commit, push, and open a pull request when the work settles.
        #[arg(long)]
        open_pr: bool,
        /// Open the pull request ready for review instead of as a draft.
        #[arg(long)]
        ready_pr: bool,
        /// Extra agent to run in the same workspace, as `provider` or
        /// `provider=prompt` (repeatable). Prompt defaults to the task prompt.
        #[arg(long = "agent")]
        agents: Vec<String>,
    },
    /// List background development tasks.
    BackgroundTasks {
        #[arg(long)]
        active_only: bool,
    },
    /// Show one background development task.
    BackgroundTask {
        background_task_id: i64,
    },
    /// Cancel a background development task.
    CancelBackgroundTask {
        background_task_id: i64,
    },
    /// Advance every active background task once, without waiting for the tick.
    TickBackgroundTasks,
    /// Create a GitHub pull request for a workspace (uses local `gh` auth).
    CreatePr {
        workspace: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        body: Option<String>,
        #[arg(long)]
        draft: bool,
        /// Fill title/body from the generated PR draft when not supplied.
        #[arg(long)]
        from_draft: bool,
    },
    /// Print the generated pull-request title and body for a workspace.
    PrDraft {
        workspace: String,
    },
    /// List workspace tasks.
    Tasks {
        workspace: String,
    },
    /// Create a workspace task.
    CreateTask {
        workspace: String,
        title: String,
        #[arg(long, default_value = "")]
        body: String,
        /// Files/areas this task is expected to touch (repeatable).
        #[arg(long = "area")]
        areas: Vec<String>,
    },
    /// Update a workspace task.
    UpdateTask {
        workspace: String,
        task_id: i64,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        body: Option<String>,
        /// todo | in_progress | blocked | review | done
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        owner_session: Option<i64>,
        /// Human owner name/handle; pass an empty string to clear.
        #[arg(long)]
        owner: Option<String>,
        #[arg(long)]
        blocked_reason: Option<String>,
        /// Reviewer notes for this task.
        #[arg(long)]
        review_notes: Option<String>,
        #[arg(long = "area")]
        areas: Vec<String>,
    },
    /// Delete a workspace task.
    DeleteTask {
        workspace: String,
        task_id: i64,
    },
    /// Attach an agent session to a task (omit --task to detach).
    AssignSessionTask {
        workspace: String,
        session_id: i64,
        #[arg(long = "task")]
        task_id: Option<i64>,
    },
    /// Declare the files/areas an agent session intends to touch.
    SessionAreas {
        workspace: String,
        session_id: i64,
        #[arg(long = "area")]
        areas: Vec<String>,
    },
    /// List stored workspace summaries.
    Summaries {
        workspace: String,
    },
    /// Save a summary for a workspace/session/task/review/handoff scope.
    SaveSummary {
        workspace: String,
        /// workspace | session | task | review | handoff
        #[arg(long, default_value = "workspace")]
        scope: String,
        #[arg(long = "scope-id")]
        scope_id: Option<i64>,
        body: String,
        #[arg(long = "source")]
        source_refs: Vec<String>,
    },
    /// Delete a stored summary.
    DeleteSummary {
        workspace: String,
        summary_id: i64,
    },
    /// Draft an operational summary without storing it.
    DraftSummary {
        workspace: String,
        #[arg(long = "session")]
        session_id: Option<i64>,
    },
    /// Refresh and store a continuously maintained summary.
    RefreshSummary {
        workspace: String,
        /// workspace | session | current_chat | task
        #[arg(long = "scope-type", default_value = "workspace")]
        scope_type: String,
        #[arg(long = "scope-id")]
        scope_id: Option<i64>,
    },
    /// Print the combined workspace/current-chat/tasks context briefing.
    ContextBriefing {
        workspace: String,
        #[arg(long = "thread-id")]
        thread_id: Option<i64>,
    },
    /// Create native tasks from clear action items in chat.
    SyncChatTasks {
        workspace: String,
        #[arg(long = "thread-id")]
        thread_id: Option<i64>,
    },
    /// List branch-local context attachments.
    Context {
        workspace: String,
    },
    /// Add a branch-local context attachment.
    AddContext {
        workspace: String,
        body_or_ref: String,
        /// local | archivum
        #[arg(long, default_value = "local")]
        source: String,
        /// note | summary | context_pack | file | memory
        #[arg(long, default_value = "note")]
        kind: String,
        #[arg(long, default_value = "")]
        scope: String,
        #[arg(long)]
        pinned: bool,
    },
    /// Remove a context attachment.
    RemoveContext {
        workspace: String,
        attachment_id: i64,
    },
    /// List per-session diff contributions in a workspace.
    Contributions {
        workspace: String,
    },
    /// List overlapping agent sessions in a workspace.
    Overlaps {
        workspace: String,
    },
    /// List the commands/checks/runs executed for one agent session.
    SessionRuns {
        workspace: String,
        session_id: i64,
    },
    /// Persist a durable snapshot of one session's diff contribution.
    SnapshotContribution {
        workspace: String,
        session_id: i64,
        /// Known risks to record with the snapshot (repeatable).
        #[arg(long = "risk")]
        risks: Vec<String>,
        /// Blocker details to record with the snapshot (repeatable).
        #[arg(long = "blocker")]
        blockers: Vec<String>,
    },
    /// List the stored per-session diff contributions in a workspace.
    DiffContributions {
        workspace: String,
    },
}

#[derive(Debug, Subcommand)]
enum ArchcarQueueCommand {
    Add {
        thread_id: i64,
        #[arg(long, value_enum, default_value_t = CliArchcarInputKind::User)]
        kind: CliArchcarInputKind,
        #[arg(long, value_parser = session_kind_parser(), default_value = "codex")]
        session_kind: SessionKind,
        #[arg(long)]
        visible_input: Option<String>,
        input: Vec<String>,
    },
    List {
        thread_id: i64,
    },
    Remove {
        queue_id: i64,
    },
}

#[derive(Debug, Subcommand)]
enum ArchcarInteractionsCommand {
    List {
        #[arg(long)]
        thread_id: Option<i64>,
        #[arg(long)]
        all: bool,
        #[arg(long)]
        detail: bool,
    },
    Show {
        interaction_id: String,
    },
    Allow {
        interaction_id: String,
        #[arg(long)]
        always: bool,
    },
    Deny {
        interaction_id: String,
        #[arg(long)]
        message: Option<String>,
    },
    Answer {
        interaction_id: String,
        #[arg(long)]
        answers_json: String,
    },
}

#[derive(Debug, Subcommand)]
enum McpCommand {
    Status {
        workspace: String,
    },
    /// Run the Archductor MCP server on stdio (what an MCP client spawns).
    Serve {
        /// Refuse tools that change state.
        #[arg(long)]
        read_only: bool,
    },
    /// First-run setup: install the archcar background service, make sure an
    /// access token exists, and print the MCP client configuration.
    Setup {
        /// Address for the token-guarded TCP listener. Defaults to loopback.
        #[arg(long)]
        listen: Option<String>,
        /// Skip installing the native background service.
        #[arg(long)]
        no_service: bool,
        /// Path to the archcar binary, when it is not beside this one.
        #[arg(long)]
        archcar_path: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum ServiceCommand {
    /// Install and start the archcar background service for this user.
    Install {
        /// Address for the token-guarded TCP listener (e.g. `7420`, or
        /// `0.0.0.0:7420` to accept connections from other machines).
        #[arg(long)]
        listen: Option<String>,
        #[arg(long)]
        archcar_path: Option<String>,
    },
    /// Stop and remove the archcar background service.
    Uninstall,
    /// Show whether the background service is installed and running.
    Status,
    /// Print the remote access token, creating one if needed.
    Token {
        /// Replace the existing token, invalidating current remote clients.
        #[arg(long)]
        rotate: bool,
    },
}

#[derive(Debug, Subcommand)]
enum ReviewCommand {
    Add {
        workspace: String,
        file: String,
        #[arg(long)]
        line: Option<i64>,
        body: Vec<String>,
    },
    List {
        workspace: String,
    },
    Resolve {
        id: i64,
    },
}

#[derive(Debug, Subcommand)]
enum RepoCommand {
    Add {
        path: PathBuf,
        #[arg(long)]
        name: Option<String>,
        #[arg(long, default_value = "origin")]
        remote: String,
        #[arg(long)]
        default_branch: Option<String>,
        #[arg(long)]
        workspace_parent: Option<PathBuf>,
    },
    List,
    Doctor {
        name: Option<String>,
    },
    Update {
        name: String,
    },
    Settings {
        name: String,
        #[command(subcommand)]
        command: RepoSettingsCommand,
    },
}

#[derive(Debug, Subcommand)]
enum RepoSettingsCommand {
    Export {
        #[arg(long)]
        local: bool,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    Import {
        input: PathBuf,
        #[arg(long)]
        local: bool,
    },
}

#[derive(Debug, Subcommand)]
enum WorkspaceCommand {
    Create {
        repository: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        branch: Option<String>,
        #[arg(long)]
        base: Option<String>,
        #[arg(long)]
        from_issue: Option<u64>,
        #[arg(long)]
        from_pr: Option<u64>,
        #[arg(long)]
        from_linear: Option<String>,
        #[arg(long)]
        prompt: Option<String>,
        #[arg(long)]
        branch_prefix: Option<String>,
    },
    List {
        #[arg(long)]
        active: bool,
    },
    Archive {
        name: String,
        #[arg(long)]
        remove_worktree: bool,
    },
    Restore {
        name: String,
    },
    Discard {
        name: String,
    },
    Delete {
        name: String,
        #[arg(long)]
        remove_worktree: bool,
        #[arg(long)]
        delete_branch: bool,
    },
    Rename {
        name: String,
        new_name: String,
    },
    Duplicate {
        name: String,
        new_name: String,
        #[arg(long)]
        branch: Option<String>,
    },
    LinkDir {
        workspace: String,
        target: String,
    },
    UnlinkDir {
        workspace: String,
        target: String,
    },
    LinkedDirs {
        workspace: String,
    },
    Branch {
        workspace: String,
        #[command(subcommand)]
        command: WorkspaceBranchCommand,
    },
    Timeline {
        workspace: String,
        #[arg(long)]
        kind: Option<String>,
    },
    SourcePreflight,
}

#[derive(Debug, Subcommand)]
enum WorkspaceBranchCommand {
    Create { branch: String },
    Checkout { branch: String },
    Rename { branch: String },
    Delete { branch: String },
}

#[derive(Debug, Subcommand)]
enum SessionCommand {
    Start {
        workspace: String,
        #[arg(long, value_parser = session_kind_parser(), default_value = "shell")]
        kind: SessionKind,
        #[arg(long)]
        plan_mode: bool,
        #[arg(long)]
        fast_mode: bool,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        approval_mode: Option<String>,
        #[arg(long)]
        reasoning_mode: Option<String>,
        #[arg(long)]
        effort_mode: Option<String>,
        #[arg(long)]
        codex_personality: Option<String>,
        #[arg(long)]
        codex_goals: Option<String>,
        #[arg(long)]
        codex_skills: Option<String>,
    },
    Open {
        workspace: String,
        #[arg(long, value_parser = session_kind_parser(), default_value = "shell")]
        kind: SessionKind,
        #[arg(long)]
        terminal: Option<String>,
        #[arg(long)]
        print_command: bool,
        #[arg(long)]
        plan_mode: bool,
        #[arg(long)]
        fast_mode: bool,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        approval_mode: Option<String>,
        #[arg(long)]
        reasoning_mode: Option<String>,
        #[arg(long)]
        effort_mode: Option<String>,
        #[arg(long)]
        codex_personality: Option<String>,
        #[arg(long)]
        codex_goals: Option<String>,
        #[arg(long)]
        codex_skills: Option<String>,
    },
    Stop {
        workspace: String,
    },
    Attach {
        workspace: String,
        #[arg(long)]
        process_id: Option<i64>,
        #[arg(long)]
        print_pty_path: bool,
    },
    Send {
        workspace: String,
        #[arg(long, value_parser = session_kind_parser(), default_value = "codex")]
        kind: SessionKind,
        #[arg(long)]
        thread_id: Option<i64>,
        #[arg(long, value_enum, default_value_t = CliArchcarInputKind::User)]
        input_kind: CliArchcarInputKind,
        #[arg(long)]
        visible_input: Option<String>,
        #[arg(long, default_value_t = 10_000)]
        timeout_ms: u64,
        #[arg(
            long,
            help = "Deliver now: steer an active agent turn or start a new turn"
        )]
        immediate: bool,
        message: Vec<String>,
    },
    List {
        workspace: String,
    },
}

#[derive(Debug, Subcommand)]
enum PrCommand {
    Create {
        workspace: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        body: Option<String>,
        #[arg(long)]
        draft: bool,
        #[arg(long)]
        from_context: bool,
    },
    Checks {
        workspace: String,
    },
    Summary {
        workspace: String,
        #[arg(long)]
        agent_prompt: bool,
    },
    ResolveThread {
        workspace: String,
        thread_id: String,
    },
    ReopenThread {
        workspace: String,
        thread_id: String,
    },
    View {
        workspace: String,
    },
    Merge {
        workspace: String,
        #[arg(long)]
        method: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum TodoCommand {
    Add {
        workspace: String,
        text: Vec<String>,
    },
    List {
        workspace: String,
    },
    Done {
        id: i64,
    },
    Sync {
        workspace: String,
    },
}

#[derive(Debug, Subcommand)]
enum CheckpointCommand {
    Create {
        workspace: String,
        #[arg(long)]
        session: Option<i64>,
        message: Vec<String>,
    },
    List {
        workspace: String,
    },
    /// Diff a checkpoint against the current working tree.
    Compare {
        workspace: String,
        id: i64,
    },
    Restore {
        workspace: String,
        id: i64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum CliArchcarInputKind {
    User,
    ReviewPrompt,
    ControlCommand,
    RawTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum CliWorkspaceGitAction {
    CreatePr,
    PushBranch,
    MergePr,
    OpenPr,
}

#[cfg(windows)]
fn main() -> Result<()> {
    thread::Builder::new()
        .name("archductor-cli".to_owned())
        .stack_size(8 * 1024 * 1024)
        .spawn(run_cli)?
        .join()
        .map_err(|panic| {
            if let Some(message) = panic.downcast_ref::<&str>() {
                anyhow::anyhow!("archductor CLI panicked: {message}")
            } else if let Some(message) = panic.downcast_ref::<String>() {
                anyhow::anyhow!("archductor CLI panicked: {message}")
            } else {
                anyhow::anyhow!("archductor CLI panicked")
            }
        })?
}

#[cfg(not(windows))]
fn main() -> Result<()> {
    run_cli()
}

fn run_cli() -> Result<()> {
    if handle_archcar_claude_hook()? {
        return Ok(());
    }
    if should_run_archcar_server_mode(std::env::args()) {
        let paths = AppPaths::from_env();
        reconcile_managed_sessions_on_startup(&paths)?;
        return ArchcarServer::bind(paths)?.serve();
    }
    let cli = Cli::parse();
    let paths = AppPaths::from_env();

    // These commands read this machine's SQLite database directly. Pointed at a
    // remote daemon they would quietly maintain a second, divergent inventory
    // while `remote status` and every `archcar` verb talk to the server.
    if let Some(name) = local_store_command_name(&cli.command) {
        if let Some(ArchcarEndpoint::Remote { address, .. }) = configured_remote_endpoint(&paths)? {
            anyhow::bail!(
                "`archductor {name}` reads this machine's database, but Archductor is connected to \
                 the remote daemon at {address}.\nUse `archductor archcar <command>` for \
                 remote-backed work, or run `archductor remote disconnect` first."
            );
        }
    }

    match cli.command {
        Command::Doctor => print_doctor(doctor::report_from_host()),
        Command::Setup { recheck } => print_setup(doctor::setup_report(recheck)),
        Command::Settings { command } => match command {
            AppSettingsCommand::Export { output } => {
                let contents = app_shared_settings_to_toml(&paths.shared_settings_path())?;
                fs::write(&output, contents)
                    .with_context(|| format!("write {}", output.display()))?;
                println!("Exported Shared settings to {}", output.display());
            }
            AppSettingsCommand::Import { input } => {
                let contents = fs::read_to_string(&input)
                    .with_context(|| format!("read {}", input.display()))?;
                save_app_shared_settings_from_toml(&paths.shared_settings_path(), &contents)?;
                let refreshed = refresh_all_repository_prompt_snapshots(&paths)?;
                println!(
                    "Imported Shared settings from {} and refreshed {refreshed} prompt snapshot(s)",
                    input.display()
                );
            }
        },
        Command::Import { command } => match command {
            ImportCommand::Conductor { source } => {
                let source = source.unwrap_or_else(default_conductor_app_database);
                let summary = import_conductor_app_database(&source, &paths.database_path)?;
                println!(
                    "Imported {} repositories and {} workspaces from {}",
                    summary.repositories_imported,
                    summary.workspaces_imported,
                    source.display()
                );
                if summary.renamed_duplicate_workspaces > 0 {
                    println!(
                        "Renamed {} duplicate workspace(s) with repository prefixes for CLI safety.",
                        summary.renamed_duplicate_workspaces
                    );
                }
                if summary.skipped_workspaces > 0 {
                    println!(
                        "Skipped {} workspace(s) with missing repository or name data.",
                        summary.skipped_workspaces
                    );
                }
            }
        },
        Command::History { command } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            match command {
                HistoryCommand::List { workspace } => {
                    let workspace_path = workspace
                        .as_deref()
                        .map(|name| store.workspace_path(name))
                        .transpose()?;
                    let sessions = store.list_local_chat_history(workspace_path.as_deref())?;
                    print!("{}", render_history_list(&sessions));
                }
                HistoryCommand::Show { process_id } => {
                    let messages = store.local_chat_history_messages(process_id)?;
                    print!("{}", render_history_messages(&messages));
                }
            }
        }
        Command::Archcar { command } => {
            let client = ArchcarClient::from_paths(&paths);
            match command {
                ArchcarCommand::Ensure { workspace, kind } => {
                    print_archcar_response(client.send(
                        ArchcarRequest::EnsureWorkspaceDefaultSession {
                            workspace,
                            kind,
                            harness: None,
                        },
                    )?);
                }
                ArchcarCommand::Spawn { workspace, kind } => {
                    print_archcar_response(client.send(ArchcarRequest::SpawnSession {
                        workspace,
                        kind,
                        harness: None,
                    })?);
                }
                ArchcarCommand::Status { session_id } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetSessionStatus { session_id })?,
                    );
                }
                ArchcarCommand::Screen { session_id } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetSessionScreen { session_id })?,
                    );
                }
                ArchcarCommand::Messages { thread_id } => {
                    match client.send(ArchcarRequest::GetSessionMessages { thread_id })? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    }
                }
                ArchcarCommand::PlanMode { thread_id, on, off } => {
                    let plan_mode = if off { false } else { on || !off };
                    match client.send(ArchcarRequest::SetChatPlanMode {
                        thread_id,
                        plan_mode,
                    })? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    }
                }
                ArchcarCommand::Plan { thread_id } => {
                    match client.send(ArchcarRequest::GetChatPlan { thread_id })? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    }
                }
                ArchcarCommand::Queue { command } => match command {
                    ArchcarQueueCommand::Add {
                        thread_id,
                        kind,
                        session_kind,
                        visible_input,
                        input,
                    } => match client.send(ArchcarRequest::QueueChatInput {
                        thread_id,
                        input: input.join(" "),
                        visible_input,
                        kind: kind.into(),
                        session_kind,
                    })? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    },
                    ArchcarQueueCommand::List { thread_id } => {
                        match client.send(ArchcarRequest::ListQueuedChatInputs { thread_id })? {
                            ArchcarResponse::Error { message } => anyhow::bail!(message),
                            ArchcarResponse::QueuedChatInputs { inputs, .. } => {
                                print!("{}", render_queued_archcar_inputs(&inputs));
                            }
                            response => print_archcar_response(response),
                        }
                    }
                    ArchcarQueueCommand::Remove { queue_id } => {
                        match client.send(ArchcarRequest::RemoveQueuedChatInput { queue_id })? {
                            ArchcarResponse::Error { message } => anyhow::bail!(message),
                            response => print_archcar_response(response),
                        }
                    }
                },
                ArchcarCommand::Interactions { command } => match command {
                    ArchcarInteractionsCommand::List {
                        thread_id,
                        all,
                        detail,
                    } => match client.send(ArchcarRequest::ListProviderInteractions {
                        thread_id,
                        pending_only: !all,
                    })? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        ArchcarResponse::ProviderInteractions { interactions } => {
                            print!("{}", render_provider_interactions(&interactions, detail));
                        }
                        response => print_archcar_response(response),
                    },
                    ArchcarInteractionsCommand::Show { interaction_id } => {
                        match client
                            .send(ArchcarRequest::GetProviderInteraction { interaction_id })?
                        {
                            ArchcarResponse::Error { message } => anyhow::bail!(message),
                            ArchcarResponse::ProviderInteraction { interaction } => {
                                print!("{}", render_provider_interaction_detail(&interaction));
                            }
                            response => print_archcar_response(response),
                        }
                    }
                    ArchcarInteractionsCommand::Allow {
                        interaction_id,
                        always,
                    } => match client.send(ArchcarRequest::ResolveProviderInteraction {
                        interaction_id,
                        resolution: archcar_allow_resolution(always)?,
                    })? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    },
                    ArchcarInteractionsCommand::Deny {
                        interaction_id,
                        message,
                    } => match client.send(ArchcarRequest::ResolveProviderInteraction {
                        interaction_id,
                        resolution: ProviderInteractionResolution::Deny { reason: message },
                    })? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    },
                    ArchcarInteractionsCommand::Answer {
                        interaction_id,
                        answers_json,
                    } => {
                        let answers = parse_answers_json(&answers_json)?;
                        match client.send(ArchcarRequest::ResolveProviderInteraction {
                            interaction_id,
                            resolution: ProviderInteractionResolution::Answer { answers },
                        })? {
                            ArchcarResponse::Error { message } => anyhow::bail!(message),
                            response => print_archcar_response(response),
                        }
                    }
                },
                ArchcarCommand::Send {
                    session_id,
                    kind,
                    visible_input,
                    immediate,
                    input,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::SendInput {
                        session_id,
                        input: input.join(" "),
                        visible_input,
                        kind: kind.into(),
                        delivery: cli_input_delivery(immediate),
                    })?);
                }
                ArchcarCommand::Model { session_id, model } => {
                    match client.send(ArchcarRequest::SetSessionModel {
                        session_id,
                        model: Some(model),
                    })? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    }
                }
                ArchcarCommand::Effort { session_id, level } => {
                    match client.send(ArchcarRequest::SetSessionEffort {
                        session_id,
                        effort: Some(level),
                    })? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    }
                }
                ArchcarCommand::Fast { session_id, off } => {
                    match client.send(ArchcarRequest::SetSessionFastMode {
                        session_id,
                        fast_mode: !off,
                    })? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    }
                }
                ArchcarCommand::PermissionMode { session_id, mode } => {
                    match client
                        .send(ArchcarRequest::SetSessionPermissionMode { session_id, mode })?
                    {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    }
                }
                ArchcarCommand::Interrupt { session_id } => {
                    match client.send(ArchcarRequest::InterruptTurn { session_id })? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    }
                }
                ArchcarCommand::Resize {
                    session_id,
                    rows,
                    cols,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::ResizeSession {
                        session_id,
                        rows,
                        cols,
                    })?);
                }
                ArchcarCommand::Kill { session_id } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::KillSession { session_id })?,
                    );
                }
                ArchcarCommand::Workspaces => {
                    print_archcar_response(client.send(ArchcarRequest::ListWorkspaces)?);
                }
                ArchcarCommand::InventorySnapshot => {
                    match client.send(ArchcarRequest::GetInventorySnapshot)? {
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        response => print_archcar_response(response),
                    }
                }
                ArchcarCommand::Repositories => {
                    print_archcar_response(client.send(ArchcarRequest::ListRepositories)?);
                }
                ArchcarCommand::AddRepository {
                    path,
                    name,
                    remote_name,
                    default_branch,
                    workspace_parent,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::AddRepository {
                        path,
                        name,
                        remote_name,
                        default_branch,
                        workspace_parent,
                    })?);
                }
                ArchcarCommand::CreateWorkspace {
                    repository,
                    name,
                    branch,
                    base_ref,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::CreateWorkspace {
                        repository,
                        name,
                        branch,
                        base_ref,
                    })?);
                }
                ArchcarCommand::ChatThreads { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListChatThreads { workspace })?,
                    );
                }
                ArchcarCommand::ChatProjection { thread_id } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetChatProjection { thread_id })?,
                    );
                }
                ArchcarCommand::ChatTranscripts { workspace, limit } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListChatTranscripts { workspace, limit })?,
                    );
                }
                ArchcarCommand::ChatTranscript { thread_id } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetChatTranscript { thread_id })?,
                    );
                }
                ArchcarCommand::ContextPlans { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListContextPlans { workspace })?,
                    );
                }
                ArchcarCommand::WorkspaceFiles { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListWorkspaceFiles { workspace })?,
                    );
                }
                ArchcarCommand::RunScript { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::RunWorkspaceScript { workspace })?,
                    );
                }
                ArchcarCommand::StopScript { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::StopWorkspaceScript { workspace })?,
                    );
                }
                ArchcarCommand::RunLog { workspace } => {
                    print_archcar_response(client.send(ArchcarRequest::GetRunLog { workspace })?);
                }
                ArchcarCommand::Timeline { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListWorkspaceTimeline { workspace })?,
                    );
                }
                ArchcarCommand::Conflicts { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListWorkspaceConflicts { workspace })?,
                    );
                }
                ArchcarCommand::LinkedDirs { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListLinkedDirectories { workspace })?,
                    );
                }
                ArchcarCommand::Commits { workspace, limit } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetRecentCommits { workspace, limit })?,
                    );
                }
                ArchcarCommand::CommitDraft { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetCommitMessageDraft { workspace })?,
                    );
                }
                ArchcarCommand::CommitDiff {
                    workspace,
                    commit,
                    path,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::GetCommitDiff {
                        workspace,
                        commit,
                        path,
                    })?);
                }
                ArchcarCommand::CheckList { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListWorkspaceChecks { workspace })?,
                    );
                }
                ArchcarCommand::RunCheck { workspace, key } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::RunWorkspaceCheck { workspace, key })?,
                    );
                }
                ArchcarCommand::CheckLog { workspace } => {
                    print_archcar_response(client.send(ArchcarRequest::GetCheckLog { workspace })?);
                }
                ArchcarCommand::Commit {
                    workspace,
                    message,
                    stage_all,
                } => {
                    print_archcar_response(client.send(
                        ArchcarRequest::CommitWorkspaceChanges {
                            workspace,
                            message,
                            stage_all,
                        },
                    )?);
                }
                ArchcarCommand::CreateFromLinear { repository, issue } => {
                    print_archcar_response(client.send(
                        ArchcarRequest::CreateWorkspaceFromLinear {
                            repository,
                            issue_id: issue,
                            name: None,
                            branch: None,
                            base_ref: None,
                        },
                    )?);
                }
                ArchcarCommand::PrReadiness { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetPullRequestReadiness { workspace })?,
                    );
                }
                ArchcarCommand::GitActionPrompt { workspace, action } => {
                    print_archcar_response(client.send(
                        ArchcarRequest::GetWorkspaceGitActionPrompt {
                            workspace,
                            action: action.into(),
                        },
                    )?);
                }
                ArchcarCommand::SpotlightStatus { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetSpotlightStatus { workspace })?,
                    );
                }
                ArchcarCommand::SpotlightStart { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::StartSpotlight { workspace })?,
                    );
                }
                ArchcarCommand::SpotlightStop { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::StopSpotlight { workspace })?,
                    );
                }
                ArchcarCommand::ReadFile { workspace, path } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ReadWorkspaceFile { workspace, path })?,
                    );
                }
                ArchcarCommand::WriteFile {
                    workspace,
                    path,
                    content,
                } => {
                    let content = match content {
                        Some(c) => c,
                        None => {
                            let mut buf = String::new();
                            std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)?;
                            buf
                        }
                    };
                    print_archcar_response(client.send(ArchcarRequest::WriteWorkspaceFile {
                        workspace,
                        path,
                        content,
                    })?);
                }
                ArchcarCommand::WorkspaceChanges {
                    workspace,
                    all,
                    commit,
                } => {
                    let scope = change_scope(
                        commit,
                        if all {
                            WorkspaceChangeScope::All
                        } else {
                            WorkspaceChangeScope::Uncommitted
                        },
                    );
                    print_archcar_response(
                        client.send(ArchcarRequest::GetWorkspaceChanges { workspace, scope })?,
                    );
                }
                ArchcarCommand::WorkspaceDiff {
                    workspace,
                    path,
                    uncommitted,
                    commit,
                } => {
                    let scope = change_scope(
                        commit,
                        if uncommitted {
                            WorkspaceChangeScope::Uncommitted
                        } else {
                            WorkspaceChangeScope::All
                        },
                    );
                    print_archcar_response(client.send(ArchcarRequest::GetWorkspaceDiff {
                        workspace,
                        path,
                        scope,
                    })?);
                }
                ArchcarCommand::Todos { workspace } => {
                    print_archcar_response(client.send(ArchcarRequest::ListTodos { workspace })?);
                }
                ArchcarCommand::StartBackgroundTask {
                    repository,
                    prompt,
                    title,
                    name,
                    branch,
                    base,
                    provider,
                    no_checks,
                    open_pr,
                    ready_pr,
                    agents,
                } => {
                    let extra_agents = agents
                        .into_iter()
                        .map(|spec| match spec.split_once('=') {
                            Some((provider, prompt)) => BackgroundAgentSpec {
                                provider: provider.trim().to_owned(),
                                prompt: Some(prompt.trim().to_owned()),
                            },
                            None => BackgroundAgentSpec {
                                provider: spec.trim().to_owned(),
                                prompt: None,
                            },
                        })
                        .collect();
                    print_archcar_response(client.send(ArchcarRequest::StartBackgroundTask {
                        input: StartBackgroundTask {
                            repository,
                            prompt,
                            title,
                            workspace_name: name,
                            branch,
                            base_ref: base,
                            provider,
                            run_checks: !no_checks,
                            open_pr,
                            draft_pr: !ready_pr,
                            extra_agents,
                        },
                    })?);
                }
                ArchcarCommand::BackgroundTasks { active_only } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListBackgroundTasks { active_only })?,
                    );
                }
                ArchcarCommand::BackgroundTask { background_task_id } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetBackgroundTask { background_task_id })?,
                    );
                }
                ArchcarCommand::CancelBackgroundTask { background_task_id } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::CancelBackgroundTask { background_task_id })?,
                    );
                }
                ArchcarCommand::TickBackgroundTasks => {
                    print_archcar_response(client.send(ArchcarRequest::TickBackgroundTasks)?);
                }
                ArchcarCommand::CreatePr {
                    workspace,
                    title,
                    body,
                    draft,
                    from_draft,
                } => {
                    let (title, body) = if from_draft && (title.is_none() || body.is_none()) {
                        match client.send(ArchcarRequest::GetPullRequestDraft {
                            workspace: workspace.clone(),
                        })? {
                            ArchcarResponse::PullRequestDraft {
                                title: drafted_title,
                                body: drafted_body,
                                ..
                            } => (
                                Some(title.unwrap_or(drafted_title)),
                                Some(body.unwrap_or(drafted_body)),
                            ),
                            ArchcarResponse::Error { message } => anyhow::bail!(message),
                            other => {
                                print_archcar_response(other);
                                (title, body)
                            }
                        }
                    } else {
                        (title, body)
                    };
                    print_archcar_response(client.send(ArchcarRequest::CreatePullRequest {
                        workspace,
                        title,
                        body,
                        draft,
                    })?);
                }
                ArchcarCommand::PrDraft { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetPullRequestDraft { workspace })?,
                    );
                }
                ArchcarCommand::Tasks { workspace } => {
                    print_archcar_response(client.send(ArchcarRequest::ListTasks { workspace })?);
                }
                ArchcarCommand::CreateTask {
                    workspace,
                    title,
                    body,
                    areas,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::CreateTask {
                        workspace,
                        title,
                        body,
                        intended_areas: areas,
                    })?);
                }
                ArchcarCommand::UpdateTask {
                    workspace,
                    task_id,
                    title,
                    body,
                    status,
                    owner_session,
                    owner,
                    blocked_reason,
                    review_notes,
                    areas,
                } => {
                    let update = TaskUpdate {
                        title,
                        body,
                        status,
                        owner_session_id: owner_session.map(Some),
                        owner: owner.map(Some),
                        intended_areas: (!areas.is_empty()).then_some(areas),
                        blocked_reason: blocked_reason.map(Some),
                        review_notes,
                    };
                    print_archcar_response(client.send(ArchcarRequest::UpdateTask {
                        workspace,
                        task_id,
                        update,
                    })?);
                }
                ArchcarCommand::DeleteTask { workspace, task_id } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::DeleteTask { workspace, task_id })?,
                    );
                }
                ArchcarCommand::AssignSessionTask {
                    workspace,
                    session_id,
                    task_id,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::AssignSessionTask {
                        workspace,
                        session_id,
                        task_id,
                    })?);
                }
                ArchcarCommand::SessionAreas {
                    workspace,
                    session_id,
                    areas,
                } => {
                    print_archcar_response(client.send(
                        ArchcarRequest::SetSessionIntendedAreas {
                            workspace,
                            session_id,
                            areas,
                        },
                    )?);
                }
                ArchcarCommand::Summaries { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListSummaries { workspace })?,
                    );
                }
                ArchcarCommand::SaveSummary {
                    workspace,
                    scope,
                    scope_id,
                    body,
                    source_refs,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::SaveSummary {
                        workspace,
                        scope_type: scope,
                        scope_id,
                        body_markdown: body,
                        source_refs,
                    })?);
                }
                ArchcarCommand::DeleteSummary {
                    workspace,
                    summary_id,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::DeleteSummary {
                        workspace,
                        summary_id,
                    })?);
                }
                ArchcarCommand::DraftSummary {
                    workspace,
                    session_id,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::DraftSummary {
                        workspace,
                        session_id,
                    })?);
                }
                ArchcarCommand::RefreshSummary {
                    workspace,
                    scope_type,
                    scope_id,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::RefreshSummary {
                        workspace,
                        scope_type,
                        scope_id,
                    })?);
                }
                ArchcarCommand::ContextBriefing {
                    workspace,
                    thread_id,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::GetContextBriefing {
                        workspace,
                        thread_id,
                    })?);
                }
                ArchcarCommand::SyncChatTasks {
                    workspace,
                    thread_id,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::SyncChatTasks {
                        workspace,
                        thread_id,
                    })?);
                }
                ArchcarCommand::Context { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListContextAttachments { workspace })?,
                    );
                }
                ArchcarCommand::AddContext {
                    workspace,
                    body_or_ref,
                    source,
                    kind,
                    scope,
                    pinned,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::AddContextAttachment {
                        workspace,
                        source,
                        kind,
                        body_or_ref,
                        scope,
                        pinned,
                    })?);
                }
                ArchcarCommand::RemoveContext {
                    workspace,
                    attachment_id,
                } => {
                    print_archcar_response(client.send(
                        ArchcarRequest::RemoveContextAttachment {
                            workspace,
                            attachment_id,
                        },
                    )?);
                }
                ArchcarCommand::Contributions { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListSessionContributions { workspace })?,
                    );
                }
                ArchcarCommand::SessionRuns {
                    workspace,
                    session_id,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::ListSessionRuns {
                        workspace,
                        session_id,
                    })?);
                }
                ArchcarCommand::SnapshotContribution {
                    workspace,
                    session_id,
                    risks,
                    blockers,
                } => {
                    print_archcar_response(client.send(
                        ArchcarRequest::SnapshotDiffContribution {
                            workspace,
                            session_id,
                            risks,
                            blockers,
                        },
                    )?);
                }
                ArchcarCommand::DiffContributions { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListDiffContributions { workspace })?,
                    );
                }
                ArchcarCommand::Overlaps { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListSessionOverlaps { workspace })?,
                    );
                }
                ArchcarCommand::AddTodo { workspace, text } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::AddTodo { workspace, text })?,
                    );
                }
                ArchcarCommand::Checkpoints { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListCheckpoints { workspace })?,
                    );
                }
                ArchcarCommand::CreateCheckpoint { workspace, message } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::CreateCheckpoint { workspace, message })?,
                    );
                }
                ArchcarCommand::RestoreCheckpoint {
                    workspace,
                    checkpoint_id,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::RestoreCheckpoint {
                        workspace,
                        checkpoint_id,
                    })?);
                }
                ArchcarCommand::CheckpointDiff {
                    workspace,
                    checkpoint_id,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::CompareCheckpoint {
                        workspace,
                        checkpoint_id,
                    })?);
                }
                ArchcarCommand::Processes { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetWorkspaceProcesses { workspace })?,
                    );
                }
                ArchcarCommand::Review { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListReviewComments { workspace })?,
                    );
                }
                ArchcarCommand::Checks { workspace } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetChecksSummary { workspace })?,
                    );
                }
                ArchcarCommand::Settings { repository } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetSettings { repository })?,
                    );
                }
                ArchcarCommand::SettingsSource { repository, layer } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::GetSettingsSource { repository, layer })?,
                    );
                }
                ArchcarCommand::Branches { repository } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListRepositoryBranches { repository })?,
                    );
                }
                ArchcarCommand::Providers => {
                    print_archcar_response(client.send(ArchcarRequest::ListAgentProviders)?);
                }
                ArchcarCommand::PromptPacks { repository } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ListPromptPacks { repository })?,
                    );
                }
                ArchcarCommand::SetPromptPack { repository, pack } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::SetActivePromptPack { repository, pack })?,
                    );
                }
                ArchcarCommand::SaveSettings {
                    repository,
                    layer,
                    content,
                } => {
                    let toml = match content {
                        Some(c) => c,
                        None => {
                            let mut buf = String::new();
                            std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)?;
                            buf
                        }
                    };
                    print_archcar_response(client.send(ArchcarRequest::SaveSettings {
                        repository,
                        layer,
                        toml,
                    })?);
                }
                ArchcarCommand::RecoverWorkspaceLifecycleJobs => {
                    print_archcar_response(
                        client.send(ArchcarRequest::RecoverWorkspaceLifecycleJobs)?,
                    );
                }
                ArchcarCommand::CreateChat {
                    workspace,
                    provider,
                    title,
                } => {
                    print_archcar_response(client.send(ArchcarRequest::CreateChatThread {
                        workspace,
                        provider,
                        title,
                    })?);
                }
                ArchcarCommand::CloseChat { thread_id } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::CloseChatThread { thread_id })?,
                    );
                }
                ArchcarCommand::ReopenChat { thread_id } => {
                    print_archcar_response(
                        client.send(ArchcarRequest::ReopenChatThread { thread_id })?,
                    );
                }
            }
        }
        Command::Repo { command } => {
            let store = RepositoryStore::open(&paths.database_path)?;
            match command {
                RepoCommand::Add {
                    path,
                    name,
                    remote,
                    default_branch,
                    workspace_parent,
                } => {
                    let repo = store.add(AddRepository {
                        name,
                        root_path: path,
                        default_branch,
                        remote_name: remote,
                        workspace_parent_path: workspace_parent,
                    })?;
                    println!(
                        "Added {} at {} (default branch: {}, workspace parent: {})",
                        repo.name,
                        repo.root_path.display(),
                        repo.default_branch,
                        repo.workspace_parent_path.display()
                    );
                }
                RepoCommand::List => {
                    for (repo, active, total) in store.list_with_workspace_counts()? {
                        println!(
                            "{:<20} {:<10} {:<6} {:>2} active / {:>2} total  {}",
                            repo.name,
                            repo.default_branch,
                            repo.remote_name,
                            active,
                            total,
                            repo.root_path.display(),
                        );
                    }
                }
                RepoCommand::Doctor { name: _ } => {
                    print_doctor(doctor::report_from_host());
                }
                RepoCommand::Update { name } => {
                    let repo = store.update(&name)?;
                    println!(
                        "Updated {} (default branch: {})",
                        repo.name, repo.default_branch
                    );
                }
                RepoCommand::Settings { name, command } => {
                    let repo = store.get_by_name(&name)?;
                    match command {
                        RepoSettingsCommand::Export { local, output } => {
                            let layer = repo_settings_layer(local);
                            let path = repo_settings_path(&repo.root_path, layer);
                            let contents = fs::read_to_string(&path)
                                .with_context(|| format!("read {}", path.display()))?;
                            if let Some(output) = output {
                                fs::write(&output, contents)
                                    .with_context(|| format!("write {}", output.display()))?;
                                println!(
                                    "Exported {} settings for {} to {}",
                                    repo_settings_layer_label(layer),
                                    repo.name,
                                    output.display()
                                );
                            } else {
                                print!("{contents}");
                            }
                        }
                        RepoSettingsCommand::Import { input, local } => {
                            let contents = fs::read_to_string(&input)
                                .with_context(|| format!("read {}", input.display()))?;
                            let layer = repo_settings_layer(local);
                            save_repository_settings_from_toml(&repo.root_path, layer, &contents)?;
                            let refreshed = WorkspaceStore::open_app_with_logs(
                                &paths.database_path,
                                &paths.logs_dir,
                            )?
                            .refresh_repository_prompt_snapshots(repo.id)?;
                            println!(
                                "Imported {} settings for {} from {} and refreshed {refreshed} prompt snapshot(s)",
                                repo_settings_layer_label(layer),
                                repo.name,
                                input.display()
                            );
                        }
                    }
                }
            }
        }
        Command::Workspace { command } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            store.recover_workspace_lifecycle_jobs()?;
            match command {
                WorkspaceCommand::Create {
                    repository,
                    name,
                    branch,
                    base,
                    from_issue,
                    from_pr,
                    from_linear,
                    prompt,
                    branch_prefix,
                } => {
                    let selected_sources = [
                        from_issue.is_some(),
                        from_pr.is_some(),
                        from_linear.is_some(),
                        prompt.is_some(),
                    ]
                    .into_iter()
                    .filter(|selected| *selected)
                    .count();
                    anyhow::ensure!(
                        selected_sources <= 1,
                        "choose only one source: --from-issue, --from-pr, --from-linear, or --prompt"
                    );
                    let workspace = if let Some(issue) = from_issue {
                        store.create_from_issue(&repository, issue, branch_prefix.as_deref())?
                    } else if let Some(pr) = from_pr {
                        store.create_from_pull_request(
                            &repository,
                            pr,
                            name.as_deref(),
                            branch.as_deref(),
                        )?
                    } else if let Some(linear) = from_linear {
                        store.create_from_linear_issue(
                            &repository,
                            &linear,
                            name.as_deref(),
                            branch.as_deref(),
                            base.as_deref(),
                        )?
                    } else if let Some(prompt) = prompt {
                        store.create_from_prompt(
                            &repository,
                            &prompt,
                            name.as_deref(),
                            branch.as_deref(),
                            base.as_deref(),
                        )?
                    } else {
                        let name = name
                            .with_context(|| "--name is required when not using a source option")?;
                        let branch = branch.with_context(|| {
                            "--branch is required when not using a source option"
                        })?;
                        store.create_lifecycle_job(CreateWorkspace {
                            repository_name: repository,
                            name,
                            branch,
                            base_ref: base,
                        })?
                    };
                    println!(
                        "Created {} at {} (branch: {}, base: {})",
                        workspace.name,
                        workspace.path.display(),
                        workspace.branch,
                        workspace.base_ref
                    );
                }
                WorkspaceCommand::List { active } => {
                    for workspace in store.list()? {
                        if active && workspace.status != "active" {
                            continue;
                        }
                        println!(
                            "{}\t{}\t{}\t{}\t{}",
                            workspace.name,
                            workspace.path.display(),
                            workspace.branch,
                            workspace.base_ref,
                            workspace.status
                        );
                    }
                }
                WorkspaceCommand::Archive {
                    name,
                    remove_worktree,
                } => {
                    let workspace = store.archive(&name, remove_worktree)?;
                    println!(
                        "Archived {} at {}",
                        workspace.name,
                        workspace.path.display()
                    );
                }
                WorkspaceCommand::Restore { name } => {
                    let workspace = store.restore(&name)?;
                    println!(
                        "Restored {} at {} (branch: {})",
                        workspace.name,
                        workspace.path.display(),
                        workspace.branch
                    );
                }
                WorkspaceCommand::Discard { name } => {
                    let workspace = store.discard(&name)?;
                    println!(
                        "Discarded {} — worktree removed and branch deleted",
                        workspace.name
                    );
                }
                WorkspaceCommand::Delete {
                    name,
                    remove_worktree,
                    delete_branch,
                } => {
                    let result =
                        store.delete_lifecycle_job(&name, remove_worktree, delete_branch)?;
                    println!("Deleted workspace {}", result.workspace.name);
                    if remove_worktree || delete_branch {
                        if let Some(err) = result.cleanup_error {
                            eprintln!(
                                "Artifact cleanup failed after metadata delete for {}: {err}",
                                result.workspace.name
                            );
                            anyhow::bail!(
                                "workspace metadata deleted but artifact cleanup failed: {err}"
                            );
                        }
                        println!("Cleaned workspace artifacts for {}", result.workspace.name);
                    }
                }
                WorkspaceCommand::Rename { name, new_name } => {
                    let workspace = store.rename(&name, &new_name)?;
                    println!(
                        "Renamed {} to {} at {}",
                        name,
                        workspace.name,
                        workspace.path.display()
                    );
                }
                WorkspaceCommand::Duplicate {
                    name,
                    new_name,
                    branch,
                } => {
                    let workspace = store.duplicate(&name, &new_name, branch.as_deref())?;
                    println!(
                        "Duplicated {} to {} at {} (branch: {})",
                        name,
                        workspace.name,
                        workspace.path.display(),
                        workspace.branch
                    );
                }
                WorkspaceCommand::LinkDir { workspace, target } => {
                    let link = store.link_workspace_directory(&workspace, &target)?;
                    println!(
                        "Linked {} into {} at {}",
                        link.target_workspace_name,
                        link.workspace_name,
                        link.link_path.display()
                    );
                }
                WorkspaceCommand::UnlinkDir { workspace, target } => {
                    let link = store.unlink_workspace_directory(&workspace, &target)?;
                    println!(
                        "Unlinked {} from {}",
                        link.target_workspace_name, link.workspace_name
                    );
                }
                WorkspaceCommand::LinkedDirs { workspace } => {
                    print!(
                        "{}",
                        render_linked_directories(&store.list_linked_directories(&workspace)?)
                    );
                }
                WorkspaceCommand::Branch { workspace, command } => match command {
                    WorkspaceBranchCommand::Create { branch } => {
                        store.create_branch(&workspace, &branch)?;
                        println!("Created branch {branch} for {workspace}");
                    }
                    WorkspaceBranchCommand::Checkout { branch } => {
                        let updated = store.checkout_branch(&workspace, &branch)?;
                        println!("Checked out {} in {}", updated.branch, updated.name);
                    }
                    WorkspaceBranchCommand::Rename { branch } => {
                        let updated = store.rename_branch(&workspace, &branch)?;
                        println!("Renamed workspace branch to {}", updated.branch);
                    }
                    WorkspaceBranchCommand::Delete { branch } => {
                        store.delete_branch(&workspace, &branch)?;
                        println!("Deleted branch {branch} for {workspace}");
                    }
                },
                WorkspaceCommand::Timeline { workspace, kind } => {
                    print!(
                        "{}",
                        render_workspace_timeline(
                            &store.workspace_timeline(&workspace, kind.as_deref())?
                        )
                    );
                }
                WorkspaceCommand::SourcePreflight => {
                    print_source_preflight(store.source_preflight());
                }
            }
        }
        Command::Run { workspace } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            let process = store.run_workspace(&workspace)?;
            println!(
                "Started run for {} as pid {} (log: {})",
                workspace,
                process.pid,
                process.log_path.display()
            );
        }
        Command::Stop { workspace } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            let process = store.stop_workspace(&workspace)?;
            println!("Stopped run for {} (pid {})", workspace, process.pid);
        }
        Command::Logs {
            workspace,
            run,
            session,
        } => {
            if run == session {
                anyhow::bail!(
                    "choose exactly one log stream, for example: archductor logs {workspace} --run"
                );
            }
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            if run {
                print!("{}", store.read_latest_run_log(&workspace)?);
            } else {
                print!("{}", store.read_latest_session_log(&workspace)?);
            }
        }
        Command::Runs { workspace } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            for run in store.list_runs(&workspace)? {
                println!(
                    "#{}\t{}\t{}\t{}\t{}",
                    run.id,
                    run.status.as_str(),
                    run.started_at,
                    run.ended_at.as_deref().unwrap_or("-"),
                    run.log_path.display(),
                );
            }
        }
        Command::Diff {
            workspace,
            name_only,
            file,
            uncommitted,
            commit,
        } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            if name_only {
                for path in store.changed_files(&workspace)? {
                    println!("{path}");
                }
            } else if let Some(commit) = commit {
                print!(
                    "{}",
                    store.commit_diff(&workspace, &commit, file.as_deref())?
                );
            } else if uncommitted {
                print!("{}", store.uncommitted_diff(&workspace, file.as_deref())?);
            } else {
                print!("{}", store.unified_diff(&workspace, file.as_deref())?);
            }
        }
        Command::Pr { command } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            match command {
                PrCommand::Create {
                    workspace,
                    title,
                    body,
                    draft,
                    from_context,
                } => {
                    let body = if from_context && body.is_none() {
                        store.read_context_brief(&workspace)?
                    } else {
                        body
                    };
                    store.push_branch(&workspace)?;
                    print!(
                        "{}",
                        store.create_pull_request(
                            &workspace,
                            title.as_deref(),
                            body.as_deref(),
                            draft
                        )?
                    );
                }
                PrCommand::Checks { workspace } => {
                    print!("{}", store.pull_request_checks(&workspace)?);
                }
                PrCommand::Summary {
                    workspace,
                    agent_prompt,
                } => {
                    if agent_prompt {
                        print!("{}", store.pull_request_readiness_agent_prompt(&workspace)?);
                    } else {
                        print!("{}", store.pull_request_readiness_text(&workspace)?);
                    }
                }
                PrCommand::ResolveThread {
                    workspace,
                    thread_id,
                } => {
                    let thread = store
                        .set_pull_request_review_thread_resolution(&workspace, &thread_id, true)?;
                    println!(
                        "Resolved review thread {} for {}",
                        thread.id.as_deref().unwrap_or(thread_id.as_str()),
                        workspace
                    );
                }
                PrCommand::ReopenThread {
                    workspace,
                    thread_id,
                } => {
                    let thread = store
                        .set_pull_request_review_thread_resolution(&workspace, &thread_id, false)?;
                    println!(
                        "Reopened review thread {} for {}",
                        thread.id.as_deref().unwrap_or(thread_id.as_str()),
                        workspace
                    );
                }
                PrCommand::View { workspace } => {
                    match store.refresh_pull_request_state(&workspace)? {
                        Some(pr) => println!("#{} {} (state: {})", pr.number, pr.url, pr.state),
                        None => println!("No pull request recorded for {workspace}"),
                    }
                }
                PrCommand::Merge { workspace, method } => {
                    print!(
                        "{}",
                        store.merge_pull_request(&workspace, method.as_deref())?
                    );
                    println!("Merged pull request for {workspace}");
                }
            }
        }
        Command::Session { command } => {
            let store = WorkspaceStore::open_app_with_logs(
                paths.database_path.clone(),
                paths.logs_dir.clone(),
            )?;
            match command {
                SessionCommand::Start {
                    workspace,
                    kind,
                    plan_mode,
                    fast_mode,
                    model,
                    approval_mode,
                    reasoning_mode,
                    effort_mode,
                    codex_personality,
                    codex_goals,
                    codex_skills,
                } => {
                    let harness = SessionHarnessOptions {
                        plan_mode,
                        fast_mode,
                        model,
                        approval_mode,
                        reasoning_mode,
                        effort_mode,
                        codex_personality,
                        codex_goals,
                        codex_skills,
                    };
                    let process = if cli_session_start_uses_archcar(kind) {
                        let existing_ids = running_session_ids(&store, &workspace)?;
                        let client = ArchcarClient::from_paths(&paths);
                        let kind: SessionKind = kind;
                        print_archcar_response(client.send(ArchcarRequest::SpawnSession {
                            workspace: workspace.clone(),
                            kind,
                            harness: Some(harness.clone()),
                        })?);
                        wait_for_new_session_process(
                            &store,
                            &workspace,
                            kind,
                            &existing_ids,
                            Duration::from_secs(5),
                        )?
                    } else {
                        store.start_session_with_options(&workspace, kind, harness)?
                    };
                    println!(
                        "Started session for {} as pid {} (log: {})",
                        workspace,
                        process.pid,
                        process.log_path.display()
                    );
                }
                SessionCommand::Open {
                    workspace,
                    kind,
                    terminal,
                    print_command,
                    plan_mode,
                    fast_mode,
                    model,
                    approval_mode,
                    reasoning_mode,
                    effort_mode,
                    codex_personality,
                    codex_goals,
                    codex_skills,
                } => {
                    let launch = store.session_launch_with_options(
                        &workspace,
                        kind,
                        SessionHarnessOptions {
                            plan_mode,
                            fast_mode,
                            model,
                            approval_mode,
                            reasoning_mode,
                            effort_mode,
                            codex_personality,
                            codex_goals,
                            codex_skills,
                        },
                    )?;
                    if print_command {
                        println!("{}", render_manual_session_command(&launch));
                    } else {
                        open_interactive_session(&launch, terminal.as_deref())?;
                    }
                }
                SessionCommand::Stop { workspace } => {
                    let sessions = store.list_sessions(&workspace)?;
                    let record = latest_running_session(&sessions).with_context(|| {
                        format!("no running session found for workspace {workspace}")
                    })?;
                    if cli_session_stop_uses_archcar(session_kind_from_process_record(
                        &store, record,
                    )?) {
                        let client = ArchcarClient::from_paths(&paths);
                        let _ = client.send(ArchcarRequest::KillSession {
                            session_id: record.id,
                        });
                    }
                    let process = store.stop_session_process(&workspace, record.id)?;
                    println!("Stopped session for {} (pid {})", workspace, process.pid);
                }
                SessionCommand::Attach {
                    workspace,
                    process_id,
                    print_pty_path,
                } => {
                    let process = resolve_attachable_session(&store, &workspace, process_id)?;
                    let pty_path = terminal_device_path_for_pid(process.pid)?;
                    if print_pty_path {
                        println!("{}", pty_path.display());
                    } else {
                        attach_to_session_pty(&pty_path)?;
                    }
                }
                SessionCommand::Send {
                    workspace,
                    kind,
                    thread_id,
                    input_kind,
                    visible_input,
                    timeout_ms,
                    immediate,
                    message,
                } => {
                    let kind: SessionKind = kind;
                    anyhow::ensure!(
                        matches!(kind, SessionKind::CODEX | SessionKind::CLAUDE),
                        "session send supports codex and claude"
                    );
                    let input = message_text_or_stdin(message)?;
                    let client = ArchcarClient::from_paths(&paths);
                    let (session_id, resolved_thread_id) = ensure_session_send_target(
                        &client,
                        &store,
                        &workspace,
                        kind,
                        thread_id,
                        Duration::from_millis(timeout_ms),
                    )?;
                    match client.send(ArchcarRequest::SendInput {
                        session_id,
                        input,
                        visible_input,
                        kind: input_kind.into(),
                        delivery: cli_input_delivery(immediate),
                    })? {
                        ArchcarResponse::Ack => {
                            println!(
                                "sent {}{} message to session {} thread {}",
                                session_kind_label(kind),
                                if immediate { " immediate" } else { "" },
                                session_id,
                                resolved_thread_id
                            );
                        }
                        ArchcarResponse::Error { message } => anyhow::bail!(message),
                        other => print_archcar_response(other),
                    }
                }
                SessionCommand::List { workspace } => {
                    for session in store.list_sessions(&workspace)? {
                        println!(
                            "#{}\t{}\t{}\t{}\t{}",
                            session.id,
                            session.status.as_str(),
                            session.started_at,
                            session.ended_at.as_deref().unwrap_or("-"),
                            session.command,
                        );
                    }
                }
            }
        }
        Command::Todo { command } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            match command {
                TodoCommand::Add { workspace, text } => {
                    let todo = store.add_todo(&workspace, &text.join(" "))?;
                    println!("Added todo #{} to {}: {}", todo.id, workspace, todo.text);
                }
                TodoCommand::List { workspace } => {
                    for todo in store.list_todos(&workspace)? {
                        println!("#{}\t{}\t{}", todo.id, todo.status, todo.text);
                    }
                }
                TodoCommand::Done { id } => {
                    let todo = store.complete_todo(id)?;
                    println!("Completed todo #{}: {}", todo.id, todo.text);
                }
                TodoCommand::Sync { workspace } => {
                    let n = store.sync_todos_from_context(&workspace)?;
                    println!("Imported {n} todo(s) from .context/todos.md into {workspace}");
                }
            }
        }
        Command::Checks { workspace } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            print_checks_summary(store.checks_summary(&workspace)?);
        }
        Command::Open { workspace, editor } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            let launch = store.editor_launch(&workspace, &editor)?;
            let mut cmd = std::process::Command::new(&launch.program);
            cmd.args(&launch.args)
                .current_dir(&launch.cwd)
                .envs(launch.env);
            cmd.spawn()
                .with_context(|| format!("launch editor {editor} for workspace {workspace}"))?;
            println!("Opened {} in {editor}", launch.cwd.display());
        }
        Command::Mcp { command } => match command {
            McpCommand::Status { workspace } => {
                let store =
                    WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
                print_mcp_status(store.mcp_status(&workspace)?);
            }
            McpCommand::Serve { read_only } => {
                let client = ArchcarClient::from_paths(&paths);
                archductor_core::mcp_server::serve_stdio(&client, read_only)?;
            }
            McpCommand::Setup {
                listen,
                no_service,
                archcar_path,
            } => run_mcp_setup(&paths, listen, no_service, archcar_path)?,
        },
        Command::Service { command } => match command {
            ServiceCommand::Install {
                listen,
                archcar_path,
            } => {
                let status = service::install(
                    &paths,
                    &service::InstallService {
                        listen,
                        archcar_path,
                    },
                )?;
                print_service_status(&status);
            }
            ServiceCommand::Uninstall => print_service_status(&service::uninstall(&paths)?),
            ServiceCommand::Status => print_service_status(&service::status(&paths)?),
            ServiceCommand::Token { rotate } => {
                let token = if rotate {
                    remote::rotate_token(&paths)?
                } else {
                    remote::ensure_token(&paths)?
                };
                println!("{token}");
                eprintln!("stored in {}", remote::token_path(&paths).display());
            }
        },
        Command::Remote { command } => match command {
            RemoteCommand::Connect {
                address,
                token,
                label,
                no_verify,
            } => {
                let address = address.trim().to_owned();
                let token = token.trim().to_owned();
                if !no_verify {
                    verify_client(&address, &token)?;
                }
                let mut clients = remote::load_clients(&paths)?;
                let id = clients.upsert(label.as_deref(), &address, &token);
                clients.active_id = Some(id);
                remote::save_clients(&paths, &clients)?;
                println!("Connected: this machine's Archductor clients now use {address}.");
                println!("Saved clients: {}", remote::clients_path(&paths).display());
                println!("Switch with `archductor remote use <client>` or `remote disconnect`.");
            }
            RemoteCommand::List => {
                let clients = remote::load_clients(&paths)?;
                let env_remote = std::env::var(remote::REMOTE_ENV)
                    .ok()
                    .filter(|value| !value.trim().is_empty());
                if let Some(address) = &env_remote {
                    println!("  (environment)      {address}  <- overrides the selection below");
                }
                let marker = |active: bool| if active { "*" } else { " " };
                println!(
                    "{} this-machine       {}",
                    marker(clients.active_id.is_none()),
                    paths.archcar_endpoint_path().display()
                );
                for client in &clients.clients {
                    println!(
                        "{} {:<18} {}",
                        marker(clients.active_id.as_deref() == Some(client.id.as_str())),
                        client.id,
                        client.address
                    );
                }
            }
            RemoteCommand::Use { client, no_verify } => {
                let key = client.trim();
                let mut clients = remote::load_clients(&paths)?;
                if matches!(key, "local" | "this-machine" | "this machine") {
                    clients.active_id = None;
                    remote::save_clients(&paths, &clients)?;
                    println!("Using this machine's local daemon.");
                } else {
                    let Some(target) = clients.find(key).cloned() else {
                        anyhow::bail!(
                            "no saved client named {key}; run `archductor remote list` to see them"
                        );
                    };
                    if !no_verify {
                        verify_client(&target.address, &target.token)?;
                    }
                    clients.active_id = Some(target.id.clone());
                    remote::save_clients(&paths, &clients)?;
                    println!("Switched to {} ({}).", target.label, target.address);
                }
            }
            RemoteCommand::Remove { client } => {
                let mut clients = remote::load_clients(&paths)?;
                let was_active = clients
                    .find(client.trim())
                    .is_some_and(|c| clients.active_id.as_deref() == Some(c.id.as_str()));
                if !clients.remove(client.trim()) {
                    anyhow::bail!("no saved client named {client}");
                }
                remote::save_clients(&paths, &clients)?;
                println!("Removed {client}.");
                if was_active {
                    println!("Now using this machine's local daemon.");
                }
            }
            RemoteCommand::Status => {
                let env_remote = std::env::var(remote::REMOTE_ENV)
                    .ok()
                    .filter(|value| !value.trim().is_empty());
                match configured_remote_endpoint(&paths)? {
                    Some(ArchcarEndpoint::Remote { address, .. }) => {
                        let source = if env_remote.is_some() {
                            "environment"
                        } else {
                            "saved profile"
                        };
                        println!("remote {address} (from {source})");
                    }
                    _ => println!("local daemon ({})", paths.archcar_endpoint_path().display()),
                }
                if env_remote.is_none() && remote::load_profile(&paths)?.is_some() {
                    println!("profile file: {}", remote::profile_path(&paths).display());
                }
            }
            RemoteCommand::Disconnect => {
                let mut clients = remote::load_clients(&paths)?;
                match clients.active().map(|c| c.label.clone()) {
                    Some(label) => {
                        clients.active_id = None;
                        remote::save_clients(&paths, &clients)?;
                        println!("Left {label}; using this machine's local daemon.");
                        println!("It stays saved — switch back with `archductor remote use`.");
                    }
                    None => println!("Already using this machine's local daemon."),
                }
                if std::env::var(remote::REMOTE_ENV).is_ok() {
                    println!(
                        "Note: {} is set in this environment and still overrides the local daemon.",
                        remote::REMOTE_ENV
                    );
                }
            }
        },
        Command::Review { command } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            match command {
                ReviewCommand::Add {
                    workspace,
                    file,
                    line,
                    body,
                } => {
                    let comment =
                        store.add_review_comment(&workspace, &file, line, &body.join(" "))?;
                    println!(
                        "Added review comment #{} on {}{}",
                        comment.id,
                        file,
                        line.map(|l| format!(":{l}")).unwrap_or_default()
                    );
                }
                ReviewCommand::List { workspace } => {
                    for comment in store.list_review_comments(&workspace)? {
                        let line = comment
                            .line_number
                            .map(|l| format!(":{l}"))
                            .unwrap_or_default();
                        println!(
                            "#{}\t{}\t{}{}\t{}",
                            comment.id, comment.status, comment.file_path, line, comment.body
                        );
                    }
                }
                ReviewCommand::Resolve { id } => {
                    let comment = store.resolve_review_comment(id)?;
                    println!(
                        "Resolved review comment #{} on {}",
                        comment.id, comment.file_path
                    );
                }
            }
        }
        Command::Archive {
            name,
            remove_worktree,
        } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            let workspace = store.archive(&name, remove_worktree)?;
            println!(
                "Archived {} at {}",
                workspace.name,
                workspace.path.display()
            );
        }
        Command::Status => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            print_status(store.list_status()?);
        }
        Command::Checkpoint { command } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            match command {
                CheckpointCommand::Create {
                    workspace,
                    session,
                    message,
                } => {
                    let cp = store.checkpoint_create(&workspace, &message.join(" "), session)?;
                    println!(
                        "Created checkpoint #{} for {} (ref: {})",
                        cp.id, workspace, cp.git_ref
                    );
                }
                CheckpointCommand::List { workspace } => {
                    for cp in store.checkpoint_list(&workspace)? {
                        println!("#{}\t{}\t{}", cp.id, cp.created_at, cp.message);
                    }
                }
                CheckpointCommand::Compare { workspace, id } => {
                    let (diff, truncated) = store.checkpoint_compare(&workspace, id)?;
                    if diff.trim().is_empty() {
                        println!("No differences between checkpoint #{id} and the working tree.");
                    } else {
                        println!("{diff}");
                        if truncated {
                            println!("[diff truncated]");
                        }
                    }
                }
                CheckpointCommand::Restore { workspace, id } => {
                    let cp = store.checkpoint_restore(&workspace, id)?;
                    println!(
                        "Restored {} to checkpoint #{} ({})",
                        workspace, cp.id, cp.git_ref
                    );
                    println!("Warning: untracked files removed. Re-run setup if needed.");
                }
            }
        }
        Command::Conflicts { workspace } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            let conflicts = store.find_conflicting_workspaces(&workspace)?;
            if conflicts.is_empty() {
                println!("No file conflicts with other active workspaces.");
            } else {
                for (other, files) in &conflicts {
                    println!("Conflicts with {other}:");
                    for f in files {
                        println!("  {f}");
                    }
                }
            }
        }
        Command::Discard { name } => {
            let store = WorkspaceStore::open_app_with_logs(paths.database_path, paths.logs_dir)?;
            let workspace = store.discard(&name)?;
            println!(
                "Discarded {} — worktree removed and branch deleted",
                workspace.name
            );
        }
    }

    Ok(())
}

fn should_run_archcar_server_mode<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut args = args.into_iter();
    let _program = args.next();
    matches!(
        args.next().as_ref().map(|arg| arg.as_ref()),
        Some("--archcar-serve")
    )
}

fn handle_archcar_claude_hook() -> Result<bool> {
    let args = std::env::args().collect::<Vec<_>>();
    let Some(index) = args.iter().position(|arg| arg == "--archcar-claude-hook") else {
        return Ok(false);
    };
    let thread_id = args
        .get(index + 1)
        .context("--archcar-claude-hook requires a thread id")?
        .parse::<i64>()
        .context("parse Claude hook thread id")?;
    let mut stdin = String::new();
    io::stdin()
        .read_to_string(&mut stdin)
        .context("read Claude hook stdin")?;
    let output = handle_claude_hook_json(thread_id, &stdin);
    println!("{output}");
    Ok(true)
}

fn refresh_all_repository_prompt_snapshots(paths: &AppPaths) -> Result<usize> {
    let repositories = RepositoryStore::open(&paths.database_path)?.list()?;
    let store = WorkspaceStore::open_app_with_logs(&paths.database_path, &paths.logs_dir)?;
    repositories.into_iter().try_fold(0, |total, repository| {
        Ok(total + store.refresh_repository_prompt_snapshots(repository.id)?)
    })
}

/// Resolve a change scope from CLI flags. Naming a commit is unambiguous about
/// which changes are wanted, so it wins over the working-tree flags.
fn change_scope(commit: Option<String>, default: WorkspaceChangeScope) -> WorkspaceChangeScope {
    match commit {
        Some(sha) => WorkspaceChangeScope::Commit { sha },
        None => default,
    }
}

/// Contact a daemon before pointing this machine at it, so a typo or a dead
/// host fails here instead of leaving every surface talking to nothing.
fn verify_client(address: &str, token: &str) -> Result<()> {
    let client = ArchcarClient::remote(address.to_owned(), token.to_owned());
    match client.send(ArchcarRequest::GetRemoteAccess)? {
        ArchcarResponse::Error { message } => {
            anyhow::bail!("remote daemon at {address} refused: {message}")
        }
        _ => {
            println!("Verified archcar at {address}.");
            Ok(())
        }
    }
}

/// The commands that open `WorkspaceStore`/`RepositoryStore` against the local
/// database instead of going through `ArchcarClient`. Returns the name to print
/// in the refusal, or `None` for commands that are safe under a remote profile.
///
/// `archcar`, `remote`, `service`, and `mcp` are absent on purpose: they either
/// speak to the configured daemon already or configure the connection itself.
/// `doctor`/`setup`/`settings` only touch host state and config files.
fn local_store_command_name(command: &Command) -> Option<&'static str> {
    match command {
        Command::History { .. } => Some("history"),
        Command::Repo { .. } => Some("repo"),
        Command::Workspace { .. } => Some("workspace"),
        Command::Run { .. } => Some("run"),
        Command::Stop { .. } => Some("stop"),
        Command::Logs { .. } => Some("logs"),
        Command::Runs { .. } => Some("runs"),
        Command::Diff { .. } => Some("diff"),
        Command::Pr { .. } => Some("pr"),
        Command::Session { .. } => Some("session"),
        Command::Todo { .. } => Some("todo"),
        Command::Checks { .. } => Some("checks"),
        Command::Open { .. } => Some("open"),
        Command::Review { .. } => Some("review"),
        Command::Archive { .. } => Some("archive"),
        Command::Status => Some("status"),
        Command::Checkpoint { .. } => Some("checkpoint"),
        Command::Conflicts { .. } => Some("conflicts"),
        Command::Discard { .. } => Some("discard"),
        _ => None,
    }
}

fn print_archcar_response(response: ArchcarResponse) {
    match response {
        ArchcarResponse::Ack => println!("ok"),
        ArchcarResponse::SessionSpawnQueued { workspace, kind } => {
            println!("queued {} session for {}", kind.display_name(), workspace);
        }
        ArchcarResponse::SessionSpawned {
            session_id,
            thread_id,
            workspace,
            kind,
            pid,
        } => {
            println!(
                "spawned {:?} session {} thread {} for {} pid {}",
                kind, session_id, thread_id, workspace, pid
            );
        }
        ArchcarResponse::SessionStatus {
            session_id,
            status,
            runtime_state,
            ready,
            capabilities,
        } => {
            println!(
                "session {} status={} state={} ready={}",
                session_id,
                status,
                runtime_state.as_str(),
                ready
            );
            if let Some(capabilities) = capabilities {
                println!(
                    "capabilities contract={} required={} optional={} observed_native={}",
                    capabilities.contract_version,
                    capabilities.required.len(),
                    capabilities.optional.len(),
                    capabilities.observed_native.len()
                );
            }
        }
        ArchcarResponse::SessionScreen { screen, .. } => print!("{screen}"),
        ArchcarResponse::SessionMessages { messages, .. } => {
            print!("{}", render_archcar_protocol_messages(&messages));
        }
        ArchcarResponse::ChatSnapshot { snapshot } => {
            println!(
                "chat snapshot thread {} messages={} events={} provider_events={} queued_inputs={} live_session={}",
                snapshot.thread_id,
                snapshot.messages.len(),
                snapshot.events.len(),
                snapshot.provider_events.len(),
                snapshot.queued_inputs.len(),
                snapshot.live_session.is_some()
            );
        }
        ArchcarResponse::QueuedChatInput { input } => {
            print!("{}", render_queued_archcar_inputs(&[input]));
        }
        ArchcarResponse::QueuedChatInputs { inputs, .. } => {
            print!("{}", render_queued_archcar_inputs(&inputs));
        }
        ArchcarResponse::ProviderInteraction { interaction } => {
            print!("{}", render_provider_interactions(&[interaction], false));
        }
        ArchcarResponse::ProviderInteractions { interactions } => {
            print!("{}", render_provider_interactions(&interactions, false));
        }
        ArchcarResponse::Workspaces { workspaces } => {
            println!("workspaces {}", workspaces.len());
            for ws in workspaces {
                println!(
                    "{} repo={} branch={} status={} +{} -{} todos={} sessions={}{}",
                    ws.name,
                    ws.repository_name,
                    ws.branch,
                    ws.status,
                    ws.diff_additions,
                    ws.diff_deletions,
                    ws.open_todos,
                    ws.active_sessions,
                    ws.pull_request_number
                        .map(|n| format!(" pr=#{n}"))
                        .unwrap_or_default()
                );
            }
        }
        ArchcarResponse::InventorySnapshot {
            repositories,
            workspaces,
            chat_threads,
        } => {
            println!(
                "inventory_snapshot repositories={} workspaces={} chat_workspaces={}",
                repositories.len(),
                workspaces.len(),
                chat_threads.len()
            );
            for repo in repositories {
                println!(
                    "repo {} active_workspaces={} total_workspaces={}",
                    repo.name, repo.active_workspaces, repo.total_workspaces
                );
            }
            for ws in workspaces {
                let chat_count = chat_threads.get(&ws.name).map(Vec::len).unwrap_or(0);
                println!(
                    "workspace {} repo={} branch={} status={} chats={}",
                    ws.name, ws.repository_name, ws.branch, ws.status, chat_count
                );
            }
        }
        ArchcarResponse::ChatThreads { workspace, threads } => {
            println!("chat_threads {} {}", workspace, threads.len());
            for t in threads {
                println!(
                    "{} provider={} status={} updated={} {}",
                    t.id, t.provider, t.status, t.updated_at, t.title
                );
            }
        }
        ArchcarResponse::ChatProjection { thread_id, items } => {
            println!("chat_projection thread {} items {}", thread_id, items.len());
            for item in items {
                let preview = item.body.replace('\n', " ");
                let preview: String = preview.chars().take(80).collect();
                println!("[{}] {} {}", item.render_class, item.status, preview);
            }
        }
        ArchcarResponse::ChatTranscripts {
            workspace,
            transcripts,
        } => {
            println!("chat_transcripts {} {}", workspace, transcripts.len());
            for t in transcripts {
                println!(
                    "{} provider={} messages={} updated={} {}",
                    t.thread_id, t.provider, t.message_count, t.updated_at, t.title
                );
            }
        }
        ArchcarResponse::ChatTranscript {
            thread_id,
            title,
            messages,
        } => {
            println!("chat_transcript {} {} {}", thread_id, messages.len(), title);
            for message in messages {
                let preview = message.content.replace('\n', " ");
                let preview: String = preview.chars().take(120).collect();
                println!("[{}] {}", message.role, preview);
            }
        }
        ArchcarResponse::ContextPlans { workspace, plans } => {
            println!("context_plans {} {}", workspace, plans.len());
            for plan in plans {
                println!("{} {}", plan.path, plan.title);
            }
        }
        ArchcarResponse::WorkspaceFiles { workspace, files } => {
            println!("workspace_files {} {}", workspace, files.len());
            for f in files {
                println!("{f}");
            }
        }
        ArchcarResponse::WorkspaceFileContent {
            workspace,
            path,
            content,
        } => {
            println!(
                "workspace_file_content {} {} {}",
                workspace,
                path,
                content.len()
            );
            print!("{content}");
        }
        ArchcarResponse::WorkspaceFileWritten { workspace, path } => {
            println!("workspace_file_written {workspace} {path}");
        }
        ArchcarResponse::WorkspaceChanges {
            workspace, files, ..
        } => {
            println!("workspace_changes {} {}", workspace, files.len());
            for f in files {
                let counts = match (f.additions, f.deletions) {
                    (Some(a), Some(d)) => format!("+{a} -{d}"),
                    _ => "binary".to_owned(),
                };
                println!("{} {}", f.path, counts);
            }
        }
        ArchcarResponse::WorkspaceDiff { workspace, diff } => {
            println!("workspace_diff {} {} bytes", workspace, diff.len());
            print!("{diff}");
        }
        ArchcarResponse::Todos { workspace, todos } => {
            println!("todos {} {}", workspace, todos.len());
            for t in todos {
                println!("#{} [{}] {}", t.id, t.status, t.text);
            }
        }
        ArchcarResponse::TodoAdded { todo } => {
            println!("todo_added #{} {}", todo.id, todo.text);
        }
        ArchcarResponse::Checkpoints {
            workspace,
            checkpoints,
        } => {
            println!("checkpoints {} {}", workspace, checkpoints.len());
            for c in checkpoints {
                println!("#{} {} {}", c.id, c.created_at, c.message);
            }
        }
        ArchcarResponse::CheckpointSaved { checkpoint } => {
            println!("checkpoint_saved #{} {}", checkpoint.id, checkpoint.message);
        }
        ArchcarResponse::WorkspaceProcesses { workspace, text } => {
            println!("workspace_processes {}", workspace);
            print!("{text}");
        }
        ArchcarResponse::WorkspaceTimeline { workspace, events } => {
            println!("workspace_timeline {workspace} {}", events.len());
            for e in events {
                println!("#{}\t{}\t{}\t{}", e.id, e.created_at, e.kind, e.summary);
            }
        }
        ArchcarResponse::WorkspaceConflicts {
            workspace,
            conflicts,
        } => {
            println!("workspace_conflicts {workspace} {}", conflicts.len());
            for c in conflicts {
                println!("{}\t{}", c.workspace, c.files.join(","));
            }
        }
        ArchcarResponse::LinkedDirectories {
            workspace,
            directories,
        } => {
            println!("linked_directories {workspace} {}", directories.len());
            for d in directories {
                println!("{}\t{}\t{}", d.target_workspace, d.link_path, d.created_at);
            }
        }
        ArchcarResponse::RecentCommits { workspace, log } => {
            println!("recent_commits {workspace}");
            print!("{log}");
        }
        ArchcarResponse::CommitMessageDraft { workspace, message } => {
            println!("commit_message_draft {workspace}");
            print!("{message}");
        }
        ArchcarResponse::CommitDiff {
            workspace,
            commit,
            diff,
        } => {
            println!("commit_diff {workspace} {commit}");
            print!("{diff}");
        }
        ArchcarResponse::RunScriptStarted {
            workspace,
            pid,
            log_path,
        } => {
            println!("run_script_started {workspace} pid={pid} log={log_path}");
        }
        ArchcarResponse::RunScriptStopped { workspace, pid } => {
            println!("run_script_stopped {workspace} pid={pid}");
        }
        ArchcarResponse::RunLog { workspace, log } => {
            println!("run_log {workspace}");
            print!("{log}");
        }
        ArchcarResponse::WorkspaceChecks { workspace, checks } => {
            println!("workspace_checks {workspace} {}", checks.len());
            for c in checks {
                println!("{}\t{}\t{}", c.key, c.label, c.command);
            }
        }
        ArchcarResponse::CheckStarted {
            workspace,
            key,
            pid,
            log_path,
        } => {
            println!("check_started {workspace} key={key} pid={pid} log={log_path}");
        }
        ArchcarResponse::CheckLog { workspace, log } => {
            println!("check_log {workspace}");
            print!("{log}");
        }
        ArchcarResponse::WorkspaceCommitted { workspace, output } => {
            println!("workspace_committed {workspace}");
            print!("{output}");
        }
        ArchcarResponse::PullRequestReadiness { workspace, text } => {
            println!("pull_request_readiness {workspace}");
            print!("{text}");
        }
        ArchcarResponse::SpotlightStatus {
            workspace,
            active,
            status,
            started_at,
        } => {
            println!(
                "spotlight_status {workspace} active={active} status={} started_at={}",
                status.as_deref().unwrap_or("-"),
                started_at.as_deref().unwrap_or("-")
            );
        }
        ArchcarResponse::WorkspaceRunScripts { workspace, scripts } => {
            println!("workspace_run_scripts {} {}", workspace, scripts.len());
            for script in scripts {
                let availability = if script.available_in.is_empty() {
                    "local".to_owned()
                } else {
                    script.available_in.join(",")
                };
                let marker = if script.default { " default" } else { "" };
                let status = if script.runnable_here {
                    "runnable"
                } else {
                    "disabled"
                };
                println!(
                    "[{status}] {} available_in={availability}{marker}",
                    script.id
                );
                if let Some(reason) = script.unavailable_reason {
                    println!("  {reason}");
                }
            }
        }
        ArchcarResponse::WorkspaceProcessStarted { workspace, process } => {
            println!(
                "workspace_process_started {} kind={} pid={} status={} log={}",
                workspace, process.kind, process.pid, process.status, process.log_path
            );
        }
        ArchcarResponse::WorkspaceProcessStopped { workspace, process } => {
            println!(
                "workspace_process_stopped {} kind={} pid={} status={} log={}",
                workspace, process.kind, process.pid, process.status, process.log_path
            );
        }
        ArchcarResponse::WorkspaceLifecycleRecovery {
            recovered,
            reconciled_processes,
        } => {
            println!(
                "workspace_lifecycle_recovery recovered={recovered} reconciled_processes={reconciled_processes}"
            );
        }
        ArchcarResponse::ReviewComments {
            workspace,
            comments,
        } => {
            println!("review_comments {} {}", workspace, comments.len());
            for c in comments {
                let loc = c.line_number.map(|n| format!(":{n}")).unwrap_or_default();
                println!("#{} [{}] {}{} {}", c.id, c.status, c.file_path, loc, c.body);
            }
        }
        ArchcarResponse::Settings { scope, toml } => {
            println!("settings {scope}");
            print!("{toml}");
        }
        ArchcarResponse::RepositoryBranches {
            repository,
            branches,
        } => {
            println!("repository_branches {repository} {}", branches.len());
            for b in branches {
                println!("{b}");
            }
        }
        ArchcarResponse::AgentProviders { providers } => {
            println!("agent_providers {}", providers.len());
            for provider in providers {
                println!(
                    "{:<14} {:<20} launchable={:<5} tier={:<7} {}",
                    provider.provider_key,
                    provider.display_name,
                    provider.launchable,
                    provider.tier,
                    provider.default_command
                );
            }
        }
        ArchcarResponse::PromptPacks {
            repository,
            packs,
            active,
        } => {
            println!(
                "prompt_packs {repository} {} active={}",
                packs.len(),
                active.as_deref().unwrap_or("<none>")
            );
            for p in packs {
                println!("{p}");
            }
        }
        ArchcarResponse::SettingsSource { scope, layer, toml } => {
            println!("settings_source {scope} {layer}");
            print!("{toml}");
        }
        ArchcarResponse::SettingsSaved { scope, layer } => {
            println!("settings_saved {scope} {layer}");
        }
        ArchcarResponse::SetupReadiness { report } => {
            println!(
                "setup_readiness complete={} — {}",
                report.complete, report.feedback
            );
            for row in report.rows {
                let state = match row.state {
                    archductor_core::doctor::SetupRowState::Ready => "ready",
                    archductor_core::doctor::SetupRowState::Action => "action",
                    archductor_core::doctor::SetupRowState::Missing => "missing",
                };
                let flag = if row.required { "required" } else { "optional" };
                println!("  [{state}] {} ({flag}) — {}", row.name, row.detail);
            }
        }
        ArchcarResponse::ChatThreadCreated { thread } => {
            println!(
                "chat_thread_created id={} provider={} {}",
                thread.id, thread.provider, thread.title
            );
        }
        ArchcarResponse::ChecksSummary { workspace, summary } => {
            println!("checks_summary {workspace}");
            println!(
                "changed_files={} run={} check={} session={} active_sessions={} todos={}/{} review={} ahead={} conflicts={}",
                summary.changed_files,
                summary.run_status.as_deref().unwrap_or("-"),
                summary.check_status.as_deref().unwrap_or("-"),
                summary.session_status.as_deref().unwrap_or("-"),
                summary.active_sessions,
                summary.open_todos,
                summary.total_todos,
                summary.open_review_comments,
                summary.source_branch_ahead,
                summary.conflicting_workspaces,
            );
        }
        ArchcarResponse::Repositories { repositories } => {
            println!("repositories {}", repositories.len());
            for repo in repositories {
                println!(
                    "{} branch={} remote={} workspaces={}/{} path={}",
                    repo.name,
                    repo.default_branch,
                    repo.remote_name,
                    repo.active_workspaces,
                    repo.total_workspaces,
                    repo.root_path
                );
            }
        }
        ArchcarResponse::RepositoryAdded { name } => println!("repository_added {name}"),
        ArchcarResponse::RepositoryRemoved { name } => println!("repository_removed {name}"),
        ArchcarResponse::ChatPasteSaved {
            relative_path,
            label,
        } => {
            println!("chat_paste_saved path={relative_path} label={label}")
        }
        ArchcarResponse::WorkspaceCreated { name } => println!("workspace_created {name}"),
        ArchcarResponse::WorkspaceUpdated { name } => println!("workspace_updated {name}"),
        ArchcarResponse::WorkspaceRemoved { name } => println!("workspace_removed {name}"),
        ArchcarResponse::ReviewCommentAdded { comment } => {
            println!(
                "review_comment_added id={} file={}",
                comment.id, comment.file_path
            )
        }
        ArchcarResponse::WorkspaceScriptPrompt {
            workspace,
            kind,
            prompt,
        } => {
            println!("workspace_script_prompt workspace={workspace} kind={kind}");
            println!("{prompt}");
        }
        ArchcarResponse::ServiceStatus { status } => print_service_status(&status),
        ArchcarResponse::RemoteAccess {
            listen,
            token,
            token_path,
        } => {
            println!("remote listen={}", listen.as_deref().unwrap_or("disabled"));
            println!("token stored in {token_path}");
            println!("{token}");
        }
        ArchcarResponse::BackgroundTaskSaved { task } => {
            println!(
                "background_task #{} [{}] {} (workspace {})",
                task.id,
                task.status,
                task.title,
                task.workspace_name.as_deref().unwrap_or("-")
            );
            if !task.detail.is_empty() {
                println!("{}", task.detail);
            }
            if let Some(error) = task.error {
                eprintln!("error: {error}");
            }
        }
        ArchcarResponse::BackgroundTasks { tasks } => {
            println!("background_tasks count={}", tasks.len());
            for task in tasks {
                println!(
                    "#{} [{}] {} — {} ({})",
                    task.id,
                    task.status,
                    task.title,
                    task.detail,
                    task.workspace_name.as_deref().unwrap_or("-")
                );
            }
        }
        ArchcarResponse::PullRequestCreated { workspace, output } => {
            println!("pull_request_created workspace={workspace}");
            println!("{output}");
        }
        ArchcarResponse::PullRequestDraft {
            workspace,
            title,
            body,
        } => {
            println!("pull_request_draft workspace={workspace}");
            println!("title: {title}");
            println!("{body}");
        }
        ArchcarResponse::WorkspaceGitActionPrompt {
            workspace,
            action,
            prompt,
            visible_input,
        } => {
            println!("workspace_git_action_prompt workspace={workspace} action={action:?}");
            println!("visible_input: {visible_input}");
            println!("{prompt}");
        }
        ArchcarResponse::Tasks { workspace, tasks } => {
            println!("tasks workspace={workspace} count={}", tasks.len());
            for task in tasks {
                let sessions = if task.linked_session_ids.is_empty() {
                    String::new()
                } else {
                    format!(
                        " (sessions: {})",
                        task.linked_session_ids
                            .iter()
                            .map(|id| id.to_string())
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                };
                let review = if task.review_notes.is_empty() {
                    String::new()
                } else {
                    format!(" (review: {})", task.review_notes)
                };
                println!(
                    "#{} [{}] {}{}{sessions}{}{review}",
                    task.id,
                    task.status,
                    task.title,
                    task.owner
                        .map(|owner| format!(" (owner: {owner})"))
                        .unwrap_or_default(),
                    task.blocked_reason
                        .map(|reason| format!(" (blocked: {reason})"))
                        .unwrap_or_default()
                );
            }
        }
        ArchcarResponse::TaskSaved { task } => {
            println!("task_saved #{} [{}] {}", task.id, task.status, task.title);
        }
        ArchcarResponse::TaskDeleted { task_id } => println!("task_deleted #{task_id}"),
        ArchcarResponse::Summaries {
            workspace,
            summaries,
        } => {
            println!("summaries workspace={workspace} count={}", summaries.len());
            for summary in summaries {
                println!(
                    "#{} {}:{} ({} chars)",
                    summary.id,
                    summary.scope_type,
                    summary.scope_id,
                    summary.body_markdown.chars().count()
                );
            }
        }
        ArchcarResponse::SummarySaved { summary } => {
            println!(
                "summary_saved #{} {}:{}",
                summary.id, summary.scope_type, summary.scope_id
            );
        }
        ArchcarResponse::SummaryDeleted { summary_id } => {
            println!("summary_deleted #{summary_id}")
        }
        ArchcarResponse::SummaryDraft {
            workspace,
            body_markdown,
        } => {
            println!("summary_draft workspace={workspace}");
            println!("{body_markdown}");
        }
        ArchcarResponse::SummaryRefreshed { workspace, result } => {
            println!(
                "summary_refreshed workspace={workspace} scope={} scope_id={} changed={} summary=#{}",
                result.summary.scope_type,
                result.summary.scope_id,
                result.changed,
                result.summary.id
            );
        }
        ArchcarResponse::ContextBriefing { briefing } => {
            println!(
                "context_briefing workspace={} chars={}",
                briefing.workspace,
                briefing.body_markdown.chars().count()
            );
            println!("{}", briefing.body_markdown);
        }
        ArchcarResponse::TasksSynced { result } => {
            println!(
                "tasks_synced workspace={} created={} updated={} task_ids={:?}",
                result.workspace, result.created, result.updated, result.task_ids
            );
        }
        ArchcarResponse::ContextAttachments {
            workspace,
            attachments,
        } => {
            println!(
                "context_attachments workspace={workspace} count={}",
                attachments.len()
            );
            for attachment in attachments {
                println!(
                    "#{} {}/{}{} {}",
                    attachment.id,
                    attachment.source,
                    attachment.kind,
                    if attachment.pinned { " pinned" } else { "" },
                    attachment.body_or_ref
                );
            }
        }
        ArchcarResponse::ContextAttachmentAdded { attachment } => {
            println!(
                "context_attachment_added #{} {}/{}",
                attachment.id, attachment.source, attachment.kind
            );
        }
        ArchcarResponse::ContextAttachmentRemoved { attachment_id } => {
            println!("context_attachment_removed #{attachment_id}")
        }
        ArchcarResponse::SessionContributions {
            workspace,
            contributions,
        } => {
            println!(
                "session_contributions workspace={workspace} count={}",
                contributions.len()
            );
            for contribution in contributions {
                println!(
                    "session {} [{}] {} — {} file(s), {} still changed{}{}",
                    contribution.session_id,
                    contribution.status,
                    contribution.title,
                    contribution.files_touched.len(),
                    contribution.still_present.len(),
                    contribution
                        .model
                        .map(|model| format!(" model={model}"))
                        .unwrap_or_default(),
                    contribution
                        .task_title
                        .map(|title| format!(" task={title}"))
                        .unwrap_or_default()
                );
            }
        }
        ArchcarResponse::SessionOverlaps {
            workspace,
            overlaps,
        } => {
            println!(
                "session_overlaps workspace={workspace} count={}",
                overlaps.len()
            );
            for overlap in overlaps {
                println!(
                    "sessions {} and {} overlap on {}",
                    overlap.session_id,
                    overlap.other_session_id,
                    overlap.paths.join(", ")
                );
            }
        }
        ArchcarResponse::SessionRuns {
            workspace,
            session_id,
            runs,
        } => {
            println!(
                "session_runs workspace={workspace} session={session_id} count={}",
                runs.len()
            );
            for run in runs {
                println!(
                    "#{} [{}] {} — {}{}",
                    run.process_id,
                    run.kind,
                    run.command,
                    run.status,
                    run.exit_code
                        .map(|code| format!(" (exit {code})"))
                        .unwrap_or_default()
                );
            }
        }
        ArchcarResponse::CheckpointDiff {
            workspace,
            checkpoint_id,
            diff,
            truncated,
        } => {
            println!("checkpoint_diff workspace={workspace} checkpoint={checkpoint_id}");
            if diff.trim().is_empty() {
                println!("No differences from the working tree.");
            } else {
                println!("{diff}");
                if truncated {
                    println!("[diff truncated]");
                }
            }
        }
        ArchcarResponse::DiffContributionSaved { contribution } => {
            println!(
                "diff_contribution_saved session={} files={} patch={}",
                contribution.session_id,
                contribution.files.len(),
                contribution.patch_ref.as_deref().unwrap_or("-")
            );
        }
        ArchcarResponse::DiffContributions {
            workspace,
            contributions,
        } => {
            println!(
                "diff_contributions workspace={workspace} count={}",
                contributions.len()
            );
            for contribution in contributions {
                let risks = if contribution.risks.is_empty() {
                    String::new()
                } else {
                    format!(", risks: {}", contribution.risks.join("; "))
                };
                let blockers = if contribution.blockers.is_empty() {
                    String::new()
                } else {
                    format!(", blockers: {}", contribution.blockers.join("; "))
                };
                println!(
                    "session {} — {} file(s), {} still changed, patch={}{risks}{blockers}",
                    contribution.session_id,
                    contribution.files.len(),
                    contribution.still_present.len(),
                    contribution.patch_ref.as_deref().unwrap_or("-")
                );
            }
        }
        ArchcarResponse::ChatPlan {
            thread_id,
            plan_mode,
            plan_path,
            plan_markdown,
        } => {
            println!(
                "chat_plan thread={thread_id} plan_mode={plan_mode} path={}",
                plan_path.as_deref().unwrap_or("-")
            );
            if let Some(markdown) = plan_markdown {
                println!("{markdown}");
            }
        }
        ArchcarResponse::Error { message } => {
            eprintln!("{message}");
        }
    }
}

fn render_queued_archcar_inputs(inputs: &[QueuedArchcarInput]) -> String {
    let mut output = String::new();
    if inputs.is_empty() {
        output.push_str("queued chat inputs 0\n");
        return output;
    }
    for input in inputs {
        let preview = input
            .visible_input
            .as_deref()
            .unwrap_or(&input.input)
            .replace('\n', " ");
        output.push_str(&format!(
            "{} thread={} kind={:?} session_kind={:?} chars={} {}\n",
            input.id,
            input.thread_id,
            input.kind,
            input.session_kind,
            input.input.chars().count(),
            preview
        ));
    }
    output
}

fn render_provider_interactions(
    interactions: &[ProviderInteractionRecord],
    detail: bool,
) -> String {
    let mut output = String::new();
    if interactions.is_empty() {
        output.push_str("provider interactions 0\n");
        return output;
    }
    for interaction in interactions {
        output.push_str(&render_provider_interaction_line(interaction));
        output.push('\n');
        if detail {
            output.push_str(&render_provider_interaction_detail(interaction));
        }
    }
    output
}

fn render_provider_interaction_line(interaction: &ProviderInteractionRecord) -> String {
    let summary = interaction_summary(interaction);
    format!(
        "{} provider={} kind={} status={} thread={} {}",
        interaction.id,
        interaction.provider_key,
        provider_interaction_kind_label(interaction),
        provider_interaction_status_label(interaction),
        interaction.thread_id,
        summary
    )
}

fn render_provider_interaction_detail(interaction: &ProviderInteractionRecord) -> String {
    format!(
        "{}\nrequest={}\n",
        render_provider_interaction_line(interaction),
        serde_json::to_string_pretty(&interaction.native_request)
            .unwrap_or_else(|_| "{}".to_owned())
    )
}

fn interaction_summary(interaction: &ProviderInteractionRecord) -> String {
    let title = interaction.title.trim();
    let detail = interaction.detail.trim();
    match (title.is_empty(), detail.is_empty()) {
        (true, true) => interaction.native_id.clone(),
        (false, true) => title.to_owned(),
        (true, false) => detail.to_owned(),
        (false, false) => format!("{title}: {detail}"),
    }
}

fn provider_interaction_kind_label(interaction: &ProviderInteractionRecord) -> &'static str {
    match interaction.kind {
        archductor_core::archcar::harness_contract::ProviderInteractionKind::Permission => {
            "permission"
        }
        archductor_core::archcar::harness_contract::ProviderInteractionKind::UserQuestion => {
            "question"
        }
        archductor_core::archcar::harness_contract::ProviderInteractionKind::PlanApproval => "plan",
    }
}

fn provider_interaction_status_label(interaction: &ProviderInteractionRecord) -> &'static str {
    match interaction.status {
        archductor_core::provider_interactions::ProviderInteractionStatus::Pending => "pending",
        archductor_core::provider_interactions::ProviderInteractionStatus::Allowed => "allowed",
        archductor_core::provider_interactions::ProviderInteractionStatus::Denied => "denied",
        archductor_core::provider_interactions::ProviderInteractionStatus::Answered => "answered",
        archductor_core::provider_interactions::ProviderInteractionStatus::Expired => "expired",
        archductor_core::provider_interactions::ProviderInteractionStatus::Failed => "failed",
    }
}

/// `{"question-id": "answer"}` or `{"question-id": ["a", "b"]}` — providers
/// allow more than one choice per question.
fn parse_answers_json(value: &str) -> Result<Vec<InteractionAnswer>> {
    let json = serde_json::from_str::<serde_json::Value>(value).context("parse --answers-json")?;
    let object = json
        .as_object()
        .context("--answers-json must be a JSON object")?;
    Ok(object
        .iter()
        .map(|(key, value)| InteractionAnswer {
            question_id: key.clone(),
            values: match value {
                serde_json::Value::Array(values) => values
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| value.to_string())
                    })
                    .collect(),
                serde_json::Value::String(value) => vec![value.clone()],
                other => vec![other.to_string()],
            },
        })
        .collect())
}

fn archcar_allow_resolution(always: bool) -> Result<ProviderInteractionResolution> {
    if always {
        anyhow::bail!(
            "--always is not supported yet; run allow without --always for a one-time approval"
        );
    }
    Ok(ProviderInteractionResolution::Approve)
}

/// Only managed providers route through archcar; everything else, including
/// registered agents with no adapter, runs as a local PTY session.
fn cli_session_start_uses_archcar(kind: SessionKind) -> bool {
    archductor_core::archcar::harness::managed_harness_for_kind(kind).is_some()
}

/// Builds the `--kind` parser from the registry, so `--help` lists every
/// agent this build knows and an unknown value is rejected with that list
/// rather than failing later as a missing executable.
fn session_kind_parser() -> impl clap::builder::TypedValueParser<Value = SessionKind> {
    use clap::builder::TypedValueParser as _;
    let mut names = vec!["shell"];
    names.extend(archductor_core::agent_tools::agent_tools().map(|tool| tool.provider_key));
    clap::builder::PossibleValuesParser::new(names).map(|value| SessionKind::new(&value))
}

fn cli_session_stop_uses_archcar(kind: SessionKind) -> bool {
    matches!(kind, SessionKind::CODEX | SessionKind::CLAUDE)
}

fn render_archcar_protocol_messages(messages: &[ArchcarMessage]) -> String {
    let mut out = String::new();
    for message in messages {
        let label = archcar_role_label(&message.role);
        let content = if message.source == "provider_event"
            && !matches!(message.role.as_str(), "user" | "agent" | "assistant")
        {
            archcar_message_content_without_duplicate_title(&label, &message.content)
        } else {
            &message.content
        };
        let content = content.trim();
        if content.is_empty() {
            continue;
        }
        out.push_str(&format!("{label}\n{content}\n\n"));
    }
    out
}

fn archcar_role_label(role: &str) -> String {
    match role {
        "user" => "You".to_owned(),
        "agent" | "assistant" => "Assistant".to_owned(),
        other => sentence_case_label(other),
    }
}

fn archcar_message_content_without_duplicate_title<'a>(label: &str, content: &'a str) -> &'a str {
    content
        .strip_prefix(label)
        .and_then(|rest| rest.strip_prefix('\n'))
        .unwrap_or(content)
}

fn sentence_case_label(value: &str) -> String {
    let label = value.replace(['_', '-'], " ");
    let mut chars = label.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    format!("{}{}", first.to_uppercase(), chars.as_str())
}

fn print_checks_summary(summary: archductor_core::workspace::ChecksSummary) {
    println!(
        "Workspace: {} ({})",
        summary.workspace.name, summary.workspace.status
    );
    println!("Branch:    {}", summary.workspace.branch);
    match &summary.branch_push_state {
        Some(state) if !state.has_upstream => {
            println!("Push:      no upstream set (push with: archductor pr create)");
        }
        Some(state) => println!(
            "Push:      {} ahead, {} behind upstream",
            state.ahead, state.behind
        ),
        None => {}
    }
    if summary.source_branch_ahead > 0 {
        println!(
            "Source:    {} commit(s) ahead; merge before creating PR",
            summary.source_branch_ahead
        );
    }
    println!("Changed:   {} file(s)", summary.changed_files);
    println!(
        "Run:       {}",
        summary
            .run_status
            .map(|s| s.as_str())
            .unwrap_or("not started")
    );
    println!(
        "Session:   {} ({} active)",
        summary
            .session_status
            .map(|s| s.as_str())
            .unwrap_or("not started"),
        summary.active_sessions
    );
    match summary.pull_request {
        Some(pr) => println!("PR:        #{} {} ({})", pr.number, pr.url, pr.state),
        None => println!("PR:        none"),
    }
    println!(
        "Todos:     {} open / {} total",
        summary.open_todos, summary.total_todos
    );
    println!(
        "Review:    {} open comment(s)",
        summary.open_review_comments
    );
    if !summary.conflicting_workspaces.is_empty() {
        println!("Conflicts:");
        for (other, files) in &summary.conflicting_workspaces {
            println!("  {other}: {}", files.join(", "));
        }
    }
}

fn print_source_preflight(preflight: archductor_core::workspace::WorkspaceSourcePreflight) {
    println!("Workspace source preflight");
    println!("GitHub: {}", preflight.github_status());
    println!("Linear: {}", preflight.linear_status());
}

fn render_linked_directories(links: &[LinkedDirectory]) -> String {
    if links.is_empty() {
        return "No linked directories.\n".to_owned();
    }
    let mut out = String::new();
    for link in links {
        out.push_str(&format!(
            "{}\t{}\t{}\n",
            link.target_workspace_name,
            link.target_workspace_path.display(),
            link.link_path.display()
        ));
    }
    out
}

fn render_workspace_timeline(events: &[WorkspaceTimelineEvent]) -> String {
    let mut out = String::new();
    for event in events {
        out.push_str(&format!(
            "#{}\t{}\t{}\t{}\n",
            event.id, event.created_at, event.kind, event.summary
        ));
    }
    out
}

fn render_history_list(sessions: &[LocalChatHistorySummary]) -> String {
    if sessions.is_empty() {
        return "No local chat history found.\n".to_owned();
    }
    let mut out = String::new();
    for session in sessions {
        out.push_str(&format!(
            "#{}\t{}\t{}\t{}\t{}\t{} message(s)\t{}\n",
            session.process_id,
            session.status,
            session.updated_at,
            session.repository_name,
            session.workspace_name,
            session.message_count,
            session.preview.replace('\n', " ")
        ));
    }
    out
}

fn render_history_messages(messages: &[LocalChatHistoryMessage]) -> String {
    if messages.is_empty() {
        return "No messages in this chat.\n".to_owned();
    }
    let mut out = String::new();
    for message in messages {
        out.push_str(history_role_label(&message.role));
        out.push('\n');
        out.push_str(&message.content);
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

fn history_role_label(role: &str) -> &'static str {
    match role {
        "user" => "You",
        "review" => "Review Prompt",
        "system" => "System",
        _ => "Agent",
    }
}

fn repo_settings_layer(local: bool) -> SettingsLayer {
    if local {
        SettingsLayer::LocalOverride
    } else {
        SettingsLayer::RepositoryShared
    }
}

fn repo_settings_layer_label(layer: SettingsLayer) -> &'static str {
    match layer {
        SettingsLayer::RepositoryShared => "shared",
        SettingsLayer::LocalOverride => "local",
    }
}

fn repo_settings_path(repo_path: &Path, layer: SettingsLayer) -> PathBuf {
    match layer {
        SettingsLayer::RepositoryShared => repo_path.join(".archductor/settings.toml"),
        SettingsLayer::LocalOverride => repo_path.join(".archductor/settings.local.toml"),
    }
}

fn print_service_status(status: &service::ServiceStatus) {
    println!(
        "service manager={} installed={} running={}",
        status.manager, status.installed, status.running
    );
    if let Some(path) = &status.unit_path {
        println!("unit {path}");
    }
    if let Some(listen) = &status.listen {
        println!("listening on {listen}");
    }
    if !status.detail.is_empty() {
        println!("{}", status.detail);
    }
}

/// First-run MCP setup: make the daemon a managed background service, make sure
/// a token exists, and hand back the exact client configuration to paste.
fn run_mcp_setup(
    paths: &AppPaths,
    listen: Option<String>,
    no_service: bool,
    archcar_path: Option<String>,
) -> anyhow::Result<()> {
    let listen = listen.unwrap_or_else(|| remote::DEFAULT_REMOTE_PORT.to_string());
    let address = remote::parse_listen_addr(&listen)?;
    let token = remote::ensure_token(paths)?;

    if no_service {
        println!("skipped service install (--no-service)");
    } else {
        match service::install(
            paths,
            &service::InstallService {
                listen: Some(listen.clone()),
                archcar_path,
            },
        ) {
            Ok(status) => print_service_status(&status),
            // A missing service manager should not block the rest of setup.
            Err(err) => eprintln!(
                "service install failed: {err:#}
start archcar yourself, then rerun with --no-service"
            ),
        }
    }

    println!();
    println!("Archductor MCP server is `archductor mcp serve` (stdio).");
    println!("Add this to your MCP client configuration:");
    println!();
    let exe = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "archductor".to_owned());
    println!("{}", mcp_client_config_json(&exe));
    println!();
    println!(
        "archcar listens on {address}; token stored in {}",
        remote::token_path(paths).display()
    );
    if remote::is_public_addr(&address) {
        println!(
            "WARNING: {address} is reachable from other machines. The token is the only guard — \
             put it behind a firewall or reverse proxy you trust."
        );
    }
    println!(
        "To drive this daemon from another machine, set {}=<host>:{} and {}=<token> there.",
        remote::REMOTE_ENV,
        address.port(),
        remote::TOKEN_ENV
    );
    println!("Token: {token}");
    Ok(())
}

/// The `mcpServers` entry an MCP client needs. Kept as a helper so it is
/// covered by a test and cannot drift from the actual command name.
fn mcp_client_config_json(executable: &str) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": {
            "archductor": {
                "command": executable,
                "args": ["mcp", "serve"],
            }
        }
    }))
    .unwrap_or_default()
}

fn print_mcp_status(status: archductor_core::mcp::McpStatus) {
    println!("MCP status for {}", status.workspace_path.display());
    let groups = [
        ("Claude user (~/.claude.json)", &status.claude_user),
        ("Claude project (.mcp.json)", &status.claude_project),
        ("Codex user (~/.codex/config.toml)", &status.codex_user),
        ("Codex project (.codex/config.toml)", &status.codex_project),
        ("Cursor user (~/.cursor/mcp.json)", &status.cursor_user),
        ("Cursor project (.cursor/mcp.json)", &status.cursor_project),
    ];
    for (label, servers) in groups {
        if servers.is_empty() {
            println!("  {label}: none");
        } else {
            let names: Vec<_> = servers.iter().map(|s| s.name.as_str()).collect();
            println!("  {label}: {}", names.join(", "));
        }
    }
}

fn print_status(lines: Vec<WorkspaceStatusLine>) {
    if lines.is_empty() {
        println!("No workspaces found. Run: archductor workspace create <repo> --name <name> --branch <branch>");
        return;
    }
    for line in lines {
        let ws = &line.workspace;
        let pr = line
            .pull_request
            .as_ref()
            .map(|pr| format!("PR #{} ({})", pr.number, pr.state))
            .unwrap_or_else(|| "no PR".to_owned());
        let push = match &line.branch_push_state {
            Some(state) if !state.has_upstream => "no upstream".to_owned(),
            Some(state) => format!("↑{} ↓{}", state.ahead, state.behind),
            None => String::new(),
        };
        let run = if line.run_running {
            "running"
        } else {
            "stopped"
        };
        let sessions = match line.active_sessions {
            0 => "no session".to_owned(),
            n => format!("{n} session(s)"),
        };
        println!(
            "{:<16} {:<10} {:<28} {:<14} {:<10} {:<12} {} todo(s)  {}",
            ws.name, ws.status, ws.branch, push, run, sessions, line.open_todos, pr,
        );
    }
}

impl From<CliArchcarInputKind> for ArchcarInputKind {
    fn from(value: CliArchcarInputKind) -> Self {
        match value {
            CliArchcarInputKind::User => Self::User,
            CliArchcarInputKind::ReviewPrompt => Self::ReviewPrompt,
            CliArchcarInputKind::ControlCommand => Self::ControlCommand,
            CliArchcarInputKind::RawTerminal => Self::RawTerminal,
        }
    }
}

impl From<CliWorkspaceGitAction> for WorkspaceGitAction {
    fn from(value: CliWorkspaceGitAction) -> Self {
        match value {
            CliWorkspaceGitAction::CreatePr => Self::CreatePr,
            CliWorkspaceGitAction::PushBranch => Self::PushBranch,
            CliWorkspaceGitAction::MergePr => Self::MergePr,
            CliWorkspaceGitAction::OpenPr => Self::OpenPr,
        }
    }
}

fn cli_input_delivery(immediate: bool) -> ArchcarInputDelivery {
    if immediate {
        ArchcarInputDelivery::Immediate
    } else {
        ArchcarInputDelivery::Auto
    }
}

fn open_interactive_session(launch: &SessionLaunch, terminal: Option<&str>) -> Result<()> {
    let terminal = terminal
        .map(str::to_owned)
        .or_else(detect_terminal)
        .with_context(|| {
            format!(
                "no supported terminal emulator found; run manually:\n{}",
                render_manual_session_command(launch)
            )
        })?;
    let invocation = build_terminal_invocation(&terminal, &render_manual_session_command(launch))
        .with_context(|| format!("unsupported terminal emulator: {terminal}"))?;
    ProcessCommand::new(&invocation.program)
        .args(&invocation.args)
        .current_dir(&launch.cwd)
        .envs(launch.env.iter().map(|(key, value)| (key, value)))
        .spawn()
        .with_context(|| format!("open interactive session in {}", launch.cwd.display()))?;
    println!(
        "Opened {} session in {}",
        session_kind_label(launch.kind),
        launch.cwd.display()
    );
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct TerminalInvocation {
    program: String,
    args: Vec<String>,
}

fn build_terminal_invocation(terminal: &str, command: &str) -> Option<TerminalInvocation> {
    let terminal_key = terminal_key(terminal)?;
    let args = match terminal_key.as_str() {
        "wt" | "wt.exe" | "windows-terminal" => vec![
            "new-tab".to_owned(),
            "cmd.exe".to_owned(),
            "/D".to_owned(),
            "/S".to_owned(),
            "/C".to_owned(),
            command.to_owned(),
        ],
        "gnome-terminal" | "kgx" => vec![
            "--".to_owned(),
            "bash".to_owned(),
            "-lc".to_owned(),
            command.to_owned(),
        ],
        "konsole" | "alacritty" | "kitty" | "xterm" => {
            vec![
                "-e".to_owned(),
                "bash".to_owned(),
                "-lc".to_owned(),
                command.to_owned(),
            ]
        }
        "tilix" | "terminator" => {
            vec![
                "-e".to_owned(),
                format!("bash -lc {}", quote_shell_word(command)),
            ]
        }
        "foot" => vec!["bash".to_owned(), "-lc".to_owned(), command.to_owned()],
        "wezterm" => vec![
            "start".to_owned(),
            "--".to_owned(),
            "bash".to_owned(),
            "-lc".to_owned(),
            command.to_owned(),
        ],
        "macos-terminal" | "terminal.app" => {
            return Some(TerminalInvocation {
                program: "osascript".to_owned(),
                args: vec![
                    "-e".to_owned(),
                    format!(
                        "tell application \"Terminal\" to do script \"{}\"",
                        escape_applescript_string(command)
                    ),
                    "-e".to_owned(),
                    "tell application \"Terminal\" to activate".to_owned(),
                ],
            });
        }
        "xfce4-terminal" => {
            vec![
                "--command".to_owned(),
                format!("bash -lc {}", quote_shell_word(command)),
            ]
        }
        _ => return None,
    };
    Some(TerminalInvocation {
        program: terminal.to_owned(),
        args,
    })
}

fn terminal_key(terminal: &str) -> Option<String> {
    let trimmed = terminal.trim();
    if trimmed.is_empty() {
        return None;
    }
    Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase())
        .or_else(|| Some(trimmed.to_ascii_lowercase()))
}

fn detect_terminal() -> Option<String> {
    if let Ok(term) = std::env::var("TERMINAL") {
        if !term.trim().is_empty() && command_exists(&term) {
            return Some(term);
        }
    }
    #[cfg(windows)]
    let candidates = ["wt.exe"];
    #[cfg(not(windows))]
    let candidates = [
        "gnome-terminal",
        "kgx",
        "konsole",
        "alacritty",
        "kitty",
        "xterm",
        "tilix",
        "terminator",
        "xfce4-terminal",
    ];
    candidates
        .into_iter()
        .find(|candidate| command_exists(candidate))
        .map(str::to_owned)
        .or_else(|| {
            if cfg!(target_os = "macos") && command_exists("osascript") {
                Some("macos-terminal".to_owned())
            } else {
                None
            }
        })
}

fn command_exists(command: &str) -> bool {
    doctor::command_exists(command)
}

#[cfg(not(windows))]
fn interactive_session_command(launch: &SessionLaunch) -> String {
    format!("exec {}", shell_words(&launch.program, &launch.args))
}

#[cfg(windows)]
fn interactive_session_command(launch: &SessionLaunch) -> String {
    shell_words(&launch.program, &launch.args)
}

fn render_manual_session_command(launch: &SessionLaunch) -> String {
    #[cfg(windows)]
    {
        let env = launch
            .env
            .iter()
            .filter_map(|(key, value)| {
                value
                    .to_str()
                    .map(|value| format!("set \"{key}={}\"", escape_cmd_set_value(value)))
            })
            .collect::<Vec<_>>();
        let mut parts = env;
        parts.push(format!(
            "cd /D {}",
            quote_shell_word(&launch.cwd.to_string_lossy())
        ));
        parts.push(interactive_session_command(launch));
        parts.join(" && ")
    }
    #[cfg(not(windows))]
    {
        let mut env_parts = Vec::new();
        for (key, value) in &launch.env {
            if let Some(value) = value.to_str() {
                env_parts.push(format!("{key}={}", quote_shell_word(value)));
            }
        }
        let launch_command = if env_parts.is_empty() {
            interactive_session_command(launch)
        } else {
            format!(
                "{} {}",
                env_parts.join(" "),
                interactive_session_command(launch)
            )
        };
        format!(
            "cd {} && {}",
            quote_shell_word(&launch.cwd.to_string_lossy()),
            launch_command
        )
    }
}

fn session_kind_label(kind: SessionKind) -> &'static str {
    kind.as_str()
}

fn command_session_kind_label(command: &str) -> &'static str {
    let executable = command.split_whitespace().next().unwrap_or("").trim();
    match PathBuf::from(executable)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
    {
        "codex" => "codex",
        "claude" => "claude",
        _ => "shell",
    }
}

fn wait_for_session_process(
    store: &WorkspaceStore,
    workspace: &str,
    kind: SessionKind,
    timeout: Duration,
) -> Result<ProcessRecord> {
    wait_for_session_process_matching(store, workspace, kind, None, None, timeout)
}

fn wait_for_new_session_process(
    store: &WorkspaceStore,
    workspace: &str,
    kind: SessionKind,
    existing_ids: &HashSet<i64>,
    timeout: Duration,
) -> Result<ProcessRecord> {
    wait_for_session_process_matching(store, workspace, kind, None, Some(existing_ids), timeout)
}

fn wait_for_thread_session_process(
    store: &WorkspaceStore,
    workspace: &str,
    kind: SessionKind,
    thread_id: i64,
    timeout: Duration,
) -> Result<ProcessRecord> {
    wait_for_session_process_matching(store, workspace, kind, Some(thread_id), None, timeout)
}

fn wait_for_session_process_matching(
    store: &WorkspaceStore,
    workspace: &str,
    kind: SessionKind,
    thread_id: Option<i64>,
    excluded_ids: Option<&HashSet<i64>>,
    timeout: Duration,
) -> Result<ProcessRecord> {
    let started = Instant::now();
    loop {
        for record in store.list_sessions(workspace)? {
            if record.status == ProcessStatus::Running
                && session_record_matches_kind(store, &record, kind)?
                && thread_id.is_none_or(|thread_id| record.chat_thread_id == Some(thread_id))
                && excluded_ids.is_none_or(|ids| !ids.contains(&record.id))
            {
                return Ok(record);
            }
        }
        if started.elapsed() >= timeout {
            anyhow::bail!(
                "timed out waiting for {:?} session record for workspace {}",
                kind,
                workspace
            );
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn running_session_ids(store: &WorkspaceStore, workspace: &str) -> Result<HashSet<i64>> {
    Ok(store
        .list_sessions(workspace)?
        .into_iter()
        .filter(|record| record.status == ProcessStatus::Running)
        .map(|record| record.id)
        .collect())
}

fn latest_running_session(sessions: &[ProcessRecord]) -> Option<&ProcessRecord> {
    sessions
        .iter()
        .filter(|session| session.status == ProcessStatus::Running)
        .max_by_key(|session| session.id)
}

fn session_record_matches_kind(
    store: &WorkspaceStore,
    record: &ProcessRecord,
    kind: SessionKind,
) -> Result<bool> {
    Ok(session_kind_from_process_record(store, record)? == kind)
}

fn session_kind_from_process_record(
    store: &WorkspaceStore,
    record: &ProcessRecord,
) -> Result<SessionKind> {
    if let Some(thread_id) = record.chat_thread_id {
        let thread = store.get_chat_thread_record(thread_id)?;
        return Ok(match thread.provider.as_str() {
            "codex" => SessionKind::CODEX,
            "claude" => SessionKind::CLAUDE,
            _ => SessionKind::SHELL,
        });
    }

    Ok(match command_session_kind_label(&record.command) {
        "codex" => SessionKind::CODEX,
        "claude" => SessionKind::CLAUDE,
        _ => SessionKind::SHELL,
    })
}

fn ensure_session_send_target(
    client: &ArchcarClient,
    store: &WorkspaceStore,
    workspace: &str,
    kind: SessionKind,
    thread_id: Option<i64>,
    timeout: Duration,
) -> Result<(i64, i64)> {
    let deadline = Instant::now() + timeout;
    let response = if let Some(thread_id) = thread_id {
        client.send(ArchcarRequest::EnsureChatThreadSession {
            workspace: workspace.to_owned(),
            thread_id,
            kind,
            harness: None,
        })?
    } else {
        client.send(ArchcarRequest::EnsureWorkspaceDefaultSession {
            workspace: workspace.to_owned(),
            kind,
            harness: None,
        })?
    };

    let target = match response {
        ArchcarResponse::SessionSpawned {
            session_id,
            thread_id,
            ..
        } => (session_id, thread_id),
        ArchcarResponse::SessionSpawnQueued { .. } => {
            let remaining = remaining_duration(deadline)?;
            let process = if let Some(thread_id) = thread_id {
                wait_for_thread_session_process(store, workspace, kind, thread_id, remaining)?
            } else {
                wait_for_session_process(store, workspace, kind, remaining)?
            };
            let thread_id = process
                .chat_thread_id
                .context("queued provider session did not record a chat thread id")?;
            (process.id, thread_id)
        }
        ArchcarResponse::Error { message } => anyhow::bail!(message),
        other => anyhow::bail!("unexpected archcar response: {:?}", other),
    };
    let thread_has_visible_history = !store.list_chat_messages(target.1)?.is_empty();
    if session_send_waits_for_ready(kind, thread_has_visible_history) {
        wait_for_archcar_session_ready(client, target.0, deadline)?;
    }
    Ok(target)
}

fn session_send_waits_for_ready(kind: SessionKind, thread_has_visible_history: bool) -> bool {
    !matches!(kind, SessionKind::CLAUDE) || thread_has_visible_history
}

fn wait_for_archcar_session_ready(
    client: &ArchcarClient,
    session_id: i64,
    deadline: Instant,
) -> Result<()> {
    loop {
        match client.send(ArchcarRequest::GetSessionStatus { session_id })? {
            ArchcarResponse::SessionStatus { ready: true, .. } => return Ok(()),
            ArchcarResponse::SessionStatus {
                status,
                runtime_state,
                ..
            } if archcar_status_is_terminal(&status, runtime_state) => {
                anyhow::bail!(
                    "session {session_id} exited before becoming ready: status={} state={}",
                    status,
                    runtime_state.as_str()
                );
            }
            ArchcarResponse::SessionStatus { .. } => {}
            ArchcarResponse::Error { message } if message.contains("unknown session") => {
                anyhow::bail!("session {session_id} disappeared before becoming ready: {message}");
            }
            ArchcarResponse::Error { message } => anyhow::bail!(message),
            other => anyhow::bail!("unexpected archcar response: {:?}", other),
        }
        if Instant::now() >= deadline {
            anyhow::bail!("timed out waiting for session {session_id} to become ready");
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn remaining_duration(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .context("timed out waiting for provider session")
}

fn archcar_status_is_terminal(
    status: &str,
    runtime_state: archductor_core::session_state::AgentSessionState,
) -> bool {
    !matches!(status, "running")
        || matches!(
            runtime_state,
            archductor_core::session_state::AgentSessionState::Interrupted
                | archductor_core::session_state::AgentSessionState::Failed
                | archductor_core::session_state::AgentSessionState::Exited
                | archductor_core::session_state::AgentSessionState::Archived
        )
}

fn message_text_or_stdin(message: Vec<String>) -> Result<String> {
    if !message.is_empty() {
        let input = message.join(" ");
        anyhow::ensure!(!input.trim().is_empty(), "message is required");
        return Ok(input);
    }
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .context("read message from stdin")?;
    let input = input.trim_end_matches(['\r', '\n']).to_owned();
    anyhow::ensure!(!input.trim().is_empty(), "message is required");
    Ok(input)
}

fn resolve_attachable_session(
    store: &WorkspaceStore,
    workspace: &str,
    process_id: Option<i64>,
) -> Result<ProcessRecord> {
    let sessions = store.list_sessions(workspace)?;
    let process = if let Some(process_id) = process_id {
        sessions
            .into_iter()
            .find(|session| session.id == process_id)
            .with_context(|| {
                format!("session process {process_id} not found for workspace {workspace}")
            })?
    } else {
        sessions
            .into_iter()
            .find(|session| session.status == ProcessStatus::Running)
            .with_context(|| format!("no running session found for workspace {workspace}"))?
    };
    anyhow::ensure!(
        process.status == ProcessStatus::Running,
        "session #{} for workspace {} is not running",
        process.id,
        workspace
    );
    Ok(process)
}

fn terminal_device_path_for_pid(process_id: u32) -> Result<PathBuf> {
    let fd = format!("/proc/{process_id}/fd/0");
    let target = fs::read_link(&fd)
        .with_context(|| format!("process {process_id} is not attached to a PTY slave"))?;
    anyhow::ensure!(
        target.starts_with("/dev/pts/"),
        "process {process_id} is not attached to a PTY slave"
    );
    Ok(target)
}

fn attach_to_session_pty(path: &Path) -> Result<()> {
    let mut reader = OpenOptions::new()
        .read(true)
        .open(path)
        .with_context(|| format!("open PTY for reading {}", path.display()))?;
    let mut writer = OpenOptions::new()
        .write(true)
        .open(path)
        .with_context(|| format!("open PTY for writing {}", path.display()))?;

    let stdin_thread = thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut buffer = [0u8; 4096];
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if writer.write_all(&buffer[..n]).is_err() {
                        break;
                    }
                    if writer.flush().is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut stdout = io::stdout().lock();
    let mut buffer = [0u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                stdout
                    .write_all(&buffer[..n])
                    .context("write PTY output to stdout")?;
                stdout.flush().context("flush stdout")?;
            }
            Err(err) => return Err(err).context("read PTY output"),
        }
    }

    let _ = stdin_thread.join();
    Ok(())
}

fn shell_words(program: &std::path::Path, args: &[String]) -> String {
    let mut words = vec![quote_shell_word(&program.to_string_lossy())];
    words.extend(args.iter().map(|arg| quote_shell_word(arg)));
    words.join(" ")
}

fn quote_shell_word(value: &str) -> String {
    #[cfg(windows)]
    {
        if value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'\\' | b':' | b'.' | b'_' | b'-')
        }) {
            return value.to_owned();
        }
        format!("\"{}\"", value.replace('"', "\\\""))
    }
    #[cfg(not(windows))]
    {
        if value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
        {
            return value.to_owned();
        }
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

#[cfg(windows)]
fn escape_cmd_set_value(value: &str) -> String {
    value.replace('"', "^\"")
}

fn escape_applescript_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn print_doctor(report: doctor::DoctorReport) {
    let distro = report.distro_id.as_deref().unwrap_or("unknown");
    println!("Distro: {distro}");

    if let Some(command) = report.install_command {
        println!("Install required tools: {command}");
    } else {
        println!(
            "Install required tools: see your distro packages for git, gh, sqlite, and openssh"
        );
    }

    for dependency in report.dependencies {
        let required = if dependency.required {
            "required"
        } else {
            "optional"
        };
        let status = if dependency.installed {
            "ok"
        } else {
            "missing"
        };
        println!("{:<8} {:<8} {}", dependency.name, required, status);
    }
}

fn print_setup(report: doctor::SetupReport) {
    println!(
        "setup_readiness complete={} — {}",
        report.complete, report.feedback
    );
    for row in report.rows {
        let state = match row.state {
            doctor::SetupRowState::Ready => "ready",
            doctor::SetupRowState::Action => "action",
            doctor::SetupRowState::Missing => "missing",
        };
        let flag = if row.required { "required" } else { "optional" };
        println!("  [{state:<7}] {:<18} ({flag}) — {}", row.name, row.detail);
    }
    if let Some(error) = report.refresh_error {
        eprintln!("environment refresh failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn mcp_client_config_points_at_this_binary_and_the_serve_subcommand() {
        let config = super::mcp_client_config_json("/usr/local/bin/archductor");

        let value: serde_json::Value = serde_json::from_str(&config).unwrap();
        assert_eq!(
            value["mcpServers"]["archductor"]["command"],
            "/usr/local/bin/archductor"
        );
        assert_eq!(
            value["mcpServers"]["archductor"]["args"],
            serde_json::json!(["mcp", "serve"])
        );
    }

    use super::*;
    use std::ffi::OsString;

    fn command_of(args: &[&str]) -> Command {
        Cli::try_parse_from(args).unwrap().command
    }

    #[test]
    fn direct_store_commands_are_named_so_a_remote_profile_can_refuse_them() {
        for (args, expected) in [
            (vec!["archductor", "status"], "status"),
            (vec!["archductor", "repo", "list"], "repo"),
            (vec!["archductor", "workspace", "list"], "workspace"),
            (vec!["archductor", "conflicts", "ws"], "conflicts"),
        ] {
            assert_eq!(
                local_store_command_name(&command_of(&args)),
                Some(expected),
                "{args:?} opens the local store and must be refused under a remote profile"
            );
        }
    }

    #[test]
    fn connection_and_daemon_backed_commands_stay_usable_under_a_remote_profile() {
        for args in [
            vec!["archductor", "archcar", "workspaces"],
            vec!["archductor", "remote", "status"],
            vec!["archductor", "doctor"],
            vec!["archductor", "mcp", "serve"],
        ] {
            assert_eq!(
                local_store_command_name(&command_of(&args)),
                None,
                "{args:?} must keep working while a remote daemon is configured"
            );
        }
    }

    #[test]
    fn archcar_gained_the_verbs_a_remote_only_client_needs_to_bootstrap() {
        let add = command_of(&["archductor", "archcar", "add-repository", "/srv/repo"]);
        let Command::Archcar {
            command: ArchcarCommand::AddRepository { path, .. },
        } = add
        else {
            panic!("expected archcar add-repository");
        };
        assert_eq!(path, "/srv/repo");

        let create = command_of(&[
            "archductor",
            "archcar",
            "create-workspace",
            "demo",
            "ws",
            "feature/ws",
        ]);
        let Command::Archcar {
            command:
                ArchcarCommand::CreateWorkspace {
                    repository, branch, ..
                },
        } = create
        else {
            panic!("expected archcar create-workspace");
        };
        assert_eq!(repository, "demo");
        assert_eq!(branch, "feature/ws");
    }

    #[test]
    fn parses_app_shared_settings_export() {
        let cli = Cli::try_parse_from([
            "archductor",
            "settings",
            "export",
            "--output",
            "shared.toml",
        ])
        .unwrap();
        assert!(matches!(cli.command, Command::Settings { .. }));
    }

    #[test]
    fn terminal_invocation_wraps_interactive_command() {
        let invocation =
            build_terminal_invocation("gnome-terminal", "cd /tmp && exec codex").unwrap();
        assert_eq!(invocation.program, "gnome-terminal");
        assert_eq!(
            invocation.args,
            vec!["--", "bash", "-lc", "cd /tmp && exec codex"]
        );

        let invocation = build_terminal_invocation("kitty", "cd /tmp && exec claude").unwrap();
        assert_eq!(
            invocation.args,
            vec!["-e", "bash", "-lc", "cd /tmp && exec claude"]
        );
    }

    #[test]
    fn terminal_invocation_supports_macos_terminal() {
        let invocation =
            build_terminal_invocation("macos-terminal", "cd \"/tmp/work\" && exec codex").unwrap();
        assert_eq!(invocation.program, "osascript");
        assert_eq!(
            invocation.args,
            vec![
                "-e",
                "tell application \"Terminal\" to do script \"cd \\\"/tmp/work\\\" && exec codex\"",
                "-e",
                "tell application \"Terminal\" to activate"
            ]
        );
    }

    #[test]
    fn terminal_invocation_accepts_path_and_case_variants() {
        let invocation =
            build_terminal_invocation("/usr/bin/Kitty", "cd /tmp && exec codex").unwrap();

        assert_eq!(invocation.program, "/usr/bin/Kitty");
        assert_eq!(
            invocation.args,
            vec!["-e", "bash", "-lc", "cd /tmp && exec codex"]
        );
    }

    #[test]
    fn terminal_invocation_matches_gtk_terminal_adapters() {
        let foot = build_terminal_invocation("foot", "cd /tmp && exec codex").unwrap();
        assert_eq!(foot.args, vec!["bash", "-lc", "cd /tmp && exec codex"]);

        let wezterm = build_terminal_invocation("wezterm", "cd /tmp && exec codex").unwrap();
        assert_eq!(
            wezterm.args,
            vec!["start", "--", "bash", "-lc", "cd /tmp && exec codex"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_terminal_invocation_uses_native_cmd_shell() {
        let invocation = build_terminal_invocation("wt.exe", "codex --help").unwrap();
        assert_eq!(invocation.program, "wt.exe");
        assert_eq!(
            invocation.args,
            vec!["new-tab", "cmd.exe", "/D", "/S", "/C", "codex --help"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_manual_session_command_sets_env_and_changes_drive() {
        let launch = SessionLaunch {
            kind: SessionKind::CODEX,
            program: PathBuf::from("codex.exe"),
            args: vec!["--model".to_owned(), "gpt-test".to_owned()],
            cwd: PathBuf::from(r"C:\work space"),
            env: vec![(
                "ARCHDUCTOR_WORKSPACE_NAME".to_owned(),
                OsString::from("berlin"),
            )],
            harness_metadata: None,
            session_resume_id: None,
        };

        let command = render_manual_session_command(&launch);
        assert!(command.contains("set \"ARCHDUCTOR_WORKSPACE_NAME=berlin\""));
        assert!(command.contains("cd /D \"C:\\work space\""));
        assert!(command.ends_with("codex.exe --model gpt-test"));
        assert!(!command.contains("exec "));
    }

    #[test]
    #[cfg(not(windows))]
    fn manual_session_command_includes_workspace_env_and_program() {
        let launch = SessionLaunch {
            kind: SessionKind::CODEX,
            program: PathBuf::from("codex"),
            args: Vec::new(),
            cwd: PathBuf::from("/tmp/work space"),
            env: vec![
                (
                    "ARCHDUCTOR_WORKSPACE_NAME".to_owned(),
                    OsString::from("berlin"),
                ),
                ("ARCHDUCTOR_PORT".to_owned(), OsString::from("3000")),
            ],
            harness_metadata: None,
            session_resume_id: None,
        };

        let command = render_manual_session_command(&launch);
        assert!(command.contains("cd '/tmp/work space'"));
        assert!(command.contains("ARCHDUCTOR_WORKSPACE_NAME=berlin"));
        assert!(command.contains("ARCHDUCTOR_PORT=3000"));
        assert!(command.contains("ARCHDUCTOR_PORT=3000 exec codex"));
        assert!(command.ends_with("exec codex"));
    }

    #[test]
    fn manual_codex_session_command_keeps_bootstrap_env_out_of_prompt() {
        let launch = SessionLaunch {
            kind: SessionKind::CODEX,
            program: PathBuf::from("codex"),
            args: vec!["--model".to_owned(), "gpt-5.6-sol".to_owned()],
            cwd: PathBuf::from("/tmp/work"),
            env: vec![
                (
                    "ARCHDUCTOR_WORKSPACE_NAME".to_owned(),
                    OsString::from("berlin"),
                ),
                (
                    "ARCHDUCTOR_SESSION_BOOTSTRAP".to_owned(),
                    OsString::from("[archductor bootstrap for codex]\n/plan\n"),
                ),
            ],
            harness_metadata: Some("harness=codex;plan=true".to_owned()),
            session_resume_id: None,
        };

        let command = render_manual_session_command(&launch);
        assert!(command.contains("ARCHDUCTOR_SESSION_BOOTSTRAP"));
        #[cfg(not(windows))]
        {
            assert!(command.contains("exec codex --model gpt-5.6-sol"));
            assert!(!command.ends_with("'[archductor bootstrap for codex]\n/plan\n'"));
            assert!(!command.contains("exec codex '[archductor bootstrap for codex]"));
        }
        #[cfg(windows)]
        {
            assert!(command.contains(
                "set \"ARCHDUCTOR_SESSION_BOOTSTRAP=[archductor bootstrap for codex]\n/plan\n\""
            ));
            assert!(command.ends_with("codex --model gpt-5.6-sol"));
            assert!(!command.ends_with("[archductor bootstrap for codex]\n/plan\n"));
        }
    }

    #[test]
    fn cli_session_start_and_open_accept_explicit_model() {
        let start = Cli::try_parse_from([
            "archductor",
            "session",
            "start",
            "berlin",
            "--kind",
            "codex",
            "--model",
            "gpt-5.6-luna",
        ])
        .unwrap();
        let Command::Session {
            command: SessionCommand::Start {
                model: start_model, ..
            },
        } = start.command
        else {
            panic!("expected session start");
        };
        assert_eq!(start_model.as_deref(), Some("gpt-5.6-luna"));

        let open = Cli::try_parse_from([
            "archductor",
            "session",
            "open",
            "berlin",
            "--kind",
            "claude",
            "--model",
            "claude-sonnet-5",
            "--print-command",
        ])
        .unwrap();
        let Command::Session {
            command: SessionCommand::Open {
                model: open_model, ..
            },
        } = open.command
        else {
            panic!("expected session open");
        };
        assert_eq!(open_model.as_deref(), Some("claude-sonnet-5"));
    }

    #[test]
    fn cli_session_start_routes_provider_native_agents_through_archcar() {
        assert!(cli_session_start_uses_archcar(SessionKind::CODEX));
        assert!(cli_session_start_uses_archcar(SessionKind::CLAUDE));
        assert!(!cli_session_start_uses_archcar(SessionKind::SHELL));
    }

    #[test]
    fn cli_session_stop_routes_provider_native_agents_through_archcar() {
        assert!(cli_session_stop_uses_archcar(SessionKind::CODEX));
        assert!(cli_session_stop_uses_archcar(SessionKind::CLAUDE));
        assert!(!cli_session_stop_uses_archcar(SessionKind::SHELL));
    }

    #[test]
    fn cli_archcar_send_accepts_automation_input_kinds() {
        let control = Cli::try_parse_from([
            "archductor",
            "archcar",
            "send",
            "7",
            "--kind",
            "control-command",
            "/model",
            "gpt-5.6-sol",
        ])
        .unwrap();
        let Command::Archcar {
            command:
                ArchcarCommand::Send {
                    session_id,
                    kind,
                    visible_input,
                    immediate,
                    input,
                },
        } = control.command
        else {
            panic!("expected archcar send");
        };
        assert_eq!(session_id, 7);
        assert_eq!(kind, CliArchcarInputKind::ControlCommand);
        assert_eq!(visible_input, None);
        assert!(!immediate);
        assert_eq!(input, vec!["/model".to_owned(), "gpt-5.6-sol".to_owned()]);

        let review = Cli::try_parse_from([
            "archductor",
            "archcar",
            "send",
            "8",
            "--kind",
            "review-prompt",
            "--visible-input",
            "Review selected comments",
            "--immediate",
            "address",
            "comments",
        ])
        .unwrap();
        let Command::Archcar {
            command:
                ArchcarCommand::Send {
                    session_id,
                    kind,
                    visible_input,
                    immediate,
                    input,
                },
        } = review.command
        else {
            panic!("expected archcar send");
        };
        assert_eq!(session_id, 8);
        assert_eq!(kind, CliArchcarInputKind::ReviewPrompt);
        assert_eq!(visible_input.as_deref(), Some("Review selected comments"));
        assert!(immediate);
        assert_eq!(input, vec!["address".to_owned(), "comments".to_owned()]);

        let raw = Cli::try_parse_from([
            "archductor",
            "archcar",
            "send",
            "9",
            "--kind",
            "raw-terminal",
            "pwd\n",
        ])
        .unwrap();
        let Command::Archcar {
            command:
                ArchcarCommand::Send {
                    session_id,
                    kind,
                    visible_input,
                    immediate,
                    input,
                },
        } = raw.command
        else {
            panic!("expected archcar send");
        };
        assert_eq!(session_id, 9);
        assert_eq!(kind, CliArchcarInputKind::RawTerminal);
        assert_eq!(visible_input, None);
        assert!(!immediate);
        assert_eq!(input, vec!["pwd\n".to_owned()]);
    }

    #[test]
    fn cli_archcar_model_uses_structured_model_request() {
        let cli =
            Cli::try_parse_from(["archductor", "archcar", "model", "7", "gpt-5.6-terra"]).unwrap();

        let Command::Archcar {
            command: ArchcarCommand::Model { session_id, model },
        } = cli.command
        else {
            panic!("expected archcar model");
        };
        assert_eq!(session_id, 7);
        assert_eq!(model, "gpt-5.6-terra");
    }

    #[test]
    fn cli_archcar_control_parses_effort_and_permission_mode() {
        let effort = Cli::try_parse_from(["archductor", "archcar", "effort", "7", "high"]).unwrap();
        let Command::Archcar {
            command: ArchcarCommand::Effort { session_id, level },
        } = effort.command
        else {
            panic!("expected archcar effort");
        };
        assert_eq!(session_id, 7);
        assert_eq!(level, "high");

        let fast = Cli::try_parse_from(["archductor", "archcar", "fast", "7"]).unwrap();
        let Command::Archcar {
            command: ArchcarCommand::Fast { session_id, off },
        } = fast.command
        else {
            panic!("expected archcar fast");
        };
        assert_eq!(session_id, 7);
        assert!(!off);

        let slow = Cli::try_parse_from(["archductor", "archcar", "fast", "7", "--off"]).unwrap();
        let Command::Archcar {
            command: ArchcarCommand::Fast { session_id, off },
        } = slow.command
        else {
            panic!("expected archcar fast --off");
        };
        assert_eq!(session_id, 7);
        assert!(off);

        let permission =
            Cli::try_parse_from(["archductor", "archcar", "permission-mode", "7", "default"])
                .unwrap();
        let Command::Archcar {
            command: ArchcarCommand::PermissionMode { session_id, mode },
        } = permission.command
        else {
            panic!("expected archcar permission-mode");
        };
        assert_eq!(session_id, 7);
        assert_eq!(mode, "default");
    }

    #[test]
    fn cli_archcar_interrupt_parses_session_id() {
        let cli = Cli::try_parse_from(["archductor", "archcar", "interrupt", "7"]).unwrap();

        let Command::Archcar {
            command: ArchcarCommand::Interrupt { session_id },
        } = cli.command
        else {
            panic!("expected archcar interrupt");
        };

        assert_eq!(session_id, 7);
    }

    #[test]
    fn cli_archcar_messages_reads_thread_messages() {
        let cli = Cli::try_parse_from(["archductor", "archcar", "messages", "42"]).unwrap();

        let Command::Archcar {
            command: ArchcarCommand::Messages { thread_id },
        } = cli.command
        else {
            panic!("expected archcar messages");
        };

        assert_eq!(thread_id, 42);
    }

    #[test]
    fn cli_archcar_queue_parses_shared_archcar_queue_commands() {
        let add = Cli::try_parse_from([
            "archductor",
            "archcar",
            "queue",
            "add",
            "42",
            "--kind",
            "review-prompt",
            "--session-kind",
            "claude",
            "--visible-input",
            "Review staged comments",
            "address",
            "comments",
        ])
        .unwrap();
        let Command::Archcar {
            command:
                ArchcarCommand::Queue {
                    command:
                        ArchcarQueueCommand::Add {
                            thread_id,
                            kind,
                            session_kind,
                            visible_input,
                            input,
                        },
                },
        } = add.command
        else {
            panic!("expected archcar queue add");
        };
        assert_eq!(thread_id, 42);
        assert_eq!(kind, CliArchcarInputKind::ReviewPrompt);
        assert_eq!(session_kind, SessionKind::CLAUDE);
        assert_eq!(visible_input.as_deref(), Some("Review staged comments"));
        assert_eq!(input, vec!["address".to_owned(), "comments".to_owned()]);

        let list = Cli::try_parse_from(["archductor", "archcar", "queue", "list", "42"]).unwrap();
        let Command::Archcar {
            command:
                ArchcarCommand::Queue {
                    command: ArchcarQueueCommand::List { thread_id },
                },
        } = list.command
        else {
            panic!("expected archcar queue list");
        };
        assert_eq!(thread_id, 42);

        let remove =
            Cli::try_parse_from(["archductor", "archcar", "queue", "remove", "99"]).unwrap();
        let Command::Archcar {
            command:
                ArchcarCommand::Queue {
                    command: ArchcarQueueCommand::Remove { queue_id },
                },
        } = remove.command
        else {
            panic!("expected archcar queue remove");
        };
        assert_eq!(queue_id, 99);
    }

    #[test]
    fn cli_archcar_provider_interactions_parse_commands() {
        let list = Cli::try_parse_from([
            "archductor",
            "archcar",
            "interactions",
            "list",
            "--thread-id",
            "42",
            "--all",
        ])
        .unwrap();
        let Command::Archcar {
            command:
                ArchcarCommand::Interactions {
                    command: ArchcarInteractionsCommand::List { thread_id, all, .. },
                },
        } = list.command
        else {
            panic!("expected archcar interactions list");
        };
        assert_eq!(thread_id, Some(42));
        assert!(all);

        let answer = Cli::try_parse_from([
            "archductor",
            "archcar",
            "interactions",
            "answer",
            "interaction-1",
            "--answers-json",
            r#"{"scope":"yes"}"#,
        ])
        .unwrap();
        let Command::Archcar {
            command:
                ArchcarCommand::Interactions {
                    command:
                        ArchcarInteractionsCommand::Answer {
                            interaction_id,
                            answers_json,
                        },
                },
        } = answer.command
        else {
            panic!("expected archcar interactions answer");
        };
        assert_eq!(interaction_id, "interaction-1");
        assert_eq!(
            parse_answers_json(&answers_json).unwrap(),
            vec![InteractionAnswer {
                question_id: "scope".to_owned(),
                values: vec!["yes".to_owned()],
            }]
        );

        let always = Cli::try_parse_from([
            "archductor",
            "archcar",
            "interactions",
            "allow",
            "interaction-1",
            "--always",
        ])
        .unwrap();
        assert!(matches!(
            always.command,
            Command::Archcar {
                command: ArchcarCommand::Interactions {
                    command: ArchcarInteractionsCommand::Allow { always: true, .. }
                }
            }
        ));
    }

    #[test]
    fn archcar_interactions_allow_always_is_rejected_until_persistence_exists() {
        assert_eq!(
            archcar_allow_resolution(true).unwrap_err().to_string(),
            "--always is not supported yet; run allow without --always for a one-time approval"
        );
    }

    #[test]
    fn provider_interactions_render_concise_lines_without_raw_payload() {
        let interaction = provider_interaction_fixture();
        let concise = render_provider_interactions(std::slice::from_ref(&interaction), false);
        let detail = render_provider_interactions(&[interaction], true);

        assert!(concise.contains("interaction-1 provider=claude kind=question status=pending"));
        assert!(concise.contains("Need input: Pick a scope"));
        assert!(!concise.contains("\"secret\""));
        assert!(detail.contains("request="));
        assert!(detail.contains("\"secret\""));
    }

    #[test]
    fn cli_session_send_accepts_provider_thread_and_message() {
        let cli = Cli::try_parse_from([
            "archductor",
            "session",
            "send",
            "berlin",
            "--kind",
            "claude",
            "--thread-id",
            "42",
            "--input-kind",
            "review-prompt",
            "--visible-input",
            "Review selected comments",
            "--timeout-ms",
            "2500",
            "--immediate",
            "fix",
            "the",
            "bug",
        ])
        .unwrap();

        let Command::Session {
            command:
                SessionCommand::Send {
                    workspace,
                    kind,
                    thread_id,
                    input_kind,
                    visible_input,
                    timeout_ms,
                    immediate,
                    message,
                },
        } = cli.command
        else {
            panic!("expected session send");
        };

        assert_eq!(workspace, "berlin");
        assert_eq!(kind, SessionKind::CLAUDE);
        assert_eq!(thread_id, Some(42));
        assert_eq!(input_kind, CliArchcarInputKind::ReviewPrompt);
        assert_eq!(visible_input.as_deref(), Some("Review selected comments"));
        assert_eq!(timeout_ms, 2500);
        assert!(immediate);
        assert_eq!(
            message,
            vec!["fix".to_owned(), "the".to_owned(), "bug".to_owned()]
        );
    }

    #[test]
    fn cli_session_send_keeps_distinct_claude_thread_targets() {
        let first = Cli::try_parse_from([
            "archductor",
            "session",
            "send",
            "berlin",
            "--kind",
            "claude",
            "--thread-id",
            "101",
            "first",
        ])
        .unwrap();
        let second = Cli::try_parse_from([
            "archductor",
            "session",
            "send",
            "berlin",
            "--kind",
            "claude",
            "--thread-id",
            "202",
            "second",
        ])
        .unwrap();

        assert_eq!(
            session_send_thread_target(first),
            Some((101, "first".to_owned()))
        );
        assert_eq!(
            session_send_thread_target(second),
            Some((202, "second".to_owned()))
        );
    }

    #[test]
    fn cli_claude_session_send_does_not_wait_for_ready_before_first_input() {
        assert!(!session_send_waits_for_ready(SessionKind::CLAUDE, false));
        assert!(session_send_waits_for_ready(SessionKind::CLAUDE, true));
        assert!(session_send_waits_for_ready(SessionKind::CODEX, false));
    }

    fn session_send_thread_target(cli: Cli) -> Option<(i64, String)> {
        let Command::Session {
            command:
                SessionCommand::Send {
                    kind,
                    thread_id,
                    message,
                    ..
                },
        } = cli.command
        else {
            return None;
        };
        if kind == SessionKind::CLAUDE {
            thread_id.map(|thread_id| (thread_id, message.join(" ")))
        } else {
            None
        }
    }

    #[test]
    fn history_list_render_shows_local_session_rows() {
        let text = render_history_list(&[LocalChatHistorySummary {
            process_id: 9,
            chat_thread_id: None,
            repository_name: "demo".to_owned(),
            workspace_name: "berlin".to_owned(),
            workspace_path: PathBuf::from("/tmp/berlin"),
            agent_type: "Codex".to_owned(),
            status: "exited".to_owned(),
            started_at: "2026-06-21T01:00:00Z".to_owned(),
            updated_at: "2026-06-21T01:05:00Z".to_owned(),
            message_count: 3,
            preview: "fixed tests\nwith detail".to_owned(),
            harness: Some("plan=true".to_owned()),
        }]);

        assert!(text.contains("#9\texited\t2026-06-21T01:05:00Z\tdemo\tberlin\t3 message(s)"));
        assert!(text.contains("fixed tests with detail"));
    }

    #[test]
    fn history_message_render_labels_transcript_roles() {
        let text = render_history_messages(&[
            LocalChatHistoryMessage {
                role: "user".to_owned(),
                content: "run tests".to_owned(),
            },
            LocalChatHistoryMessage {
                role: "agent".to_owned(),
                content: "tests passed".to_owned(),
            },
        ]);

        assert!(text.contains("You\nrun tests\n\n"));
        assert!(text.contains("Agent\ntests passed\n\n"));
    }

    #[test]
    fn archcar_messages_render_projected_provider_events_without_raw_payloads() {
        let text = render_archcar_protocol_messages(&[
            ArchcarMessage {
                id: -1,
                role: "assistant".to_owned(),
                content: "Here is the answer".to_owned(),
                source: "provider_event".to_owned(),
                inline_event: None,
                context_usage: None,
            },
            ArchcarMessage {
                id: -2,
                role: "reasoning".to_owned(),
                content: "Reasoning\nChecking constraints".to_owned(),
                source: "provider_event".to_owned(),
                inline_event: None,
                context_usage: None,
            },
        ]);

        assert!(text.contains("Assistant\nHere is the answer\n\n"));
        assert!(text.contains("Reasoning\nChecking constraints\n\n"));
    }

    #[test]
    fn archcar_message_render_preserves_chat_content_that_starts_with_label() {
        let text = render_archcar_protocol_messages(&[
            ArchcarMessage {
                id: 1,
                role: "user".to_owned(),
                content: "You\nshould keep this heading".to_owned(),
                source: "user_send".to_owned(),
                inline_event: None,
                context_usage: None,
            },
            ArchcarMessage {
                id: -1,
                role: "reasoning".to_owned(),
                content: "Reasoning\nbut projection titles can be stripped".to_owned(),
                source: "provider_event".to_owned(),
                inline_event: None,
                context_usage: None,
            },
        ]);

        assert!(text.contains("You\nYou\nshould keep this heading\n\n"));
        assert!(text.contains("Reasoning\nbut projection titles can be stripped\n\n"));
    }

    #[test]
    fn message_text_or_stdin_rejects_blank_positional_message() {
        let err = message_text_or_stdin(vec!["   ".to_owned(), "\t".to_owned()]).unwrap_err();

        assert!(err.to_string().contains("message is required"));
    }

    #[test]
    fn linked_directory_render_lists_target_and_context_link() {
        let text = render_linked_directories(&[LinkedDirectory {
            id: 1,
            workspace_id: 10,
            workspace_name: "frontend".to_owned(),
            workspace_path: PathBuf::from("/tmp/frontend"),
            target_workspace_id: 11,
            target_workspace_name: "backend".to_owned(),
            target_workspace_path: PathBuf::from("/tmp/backend"),
            link_path: PathBuf::from("/tmp/frontend/.context/linked-directories/backend"),
            created_at: "2026-06-21T12:00:00Z".to_owned(),
        }]);

        assert_eq!(
            text,
            "backend\t/tmp/backend\t/tmp/frontend/.context/linked-directories/backend\n"
        );
    }

    #[test]
    fn cli_rejects_removed_internal_run_codex_session_command() {
        let parse = Cli::try_parse_from(["archductor", "internal", "run-codex-session", "demo"]);

        assert!(parse.is_err());
    }

    #[test]
    fn server_mode_detection_ignores_gtk_trailing_archcar_serve() {
        assert!(should_run_archcar_server_mode([
            "archductor",
            "--archcar-serve"
        ]));
        assert!(!should_run_archcar_server_mode([
            "archductor",
            "gtk",
            "--archcar-serve"
        ]));
    }

    #[test]
    fn cli_parses_workspace_delete_cleanup_flags() {
        let parse = Cli::try_parse_from([
            "archductor",
            "workspace",
            "delete",
            "berlin",
            "--remove-worktree",
            "--delete-branch",
        ])
        .unwrap();

        match parse.command {
            Command::Workspace {
                command:
                    WorkspaceCommand::Delete {
                        name,
                        remove_worktree,
                        delete_branch,
                    },
            } => {
                assert_eq!(name, "berlin");
                assert!(remove_worktree);
                assert!(delete_branch);
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn cli_parses_workspace_branch_actions() {
        let parse = Cli::try_parse_from([
            "archductor",
            "workspace",
            "branch",
            "berlin",
            "checkout",
            "lc/next",
        ])
        .unwrap();

        match parse.command {
            Command::Workspace {
                command:
                    WorkspaceCommand::Branch {
                        workspace,
                        command: WorkspaceBranchCommand::Checkout { branch },
                    },
            } => {
                assert_eq!(workspace, "berlin");
                assert_eq!(branch, "lc/next");
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn cli_parses_workspace_duplicate_branch() {
        let parse = Cli::try_parse_from([
            "archductor",
            "workspace",
            "duplicate",
            "berlin",
            "oslo",
            "--branch",
            "lc/oslo",
        ])
        .unwrap();

        match parse.command {
            Command::Workspace {
                command:
                    WorkspaceCommand::Duplicate {
                        name,
                        new_name,
                        branch,
                    },
            } => {
                assert_eq!(name, "berlin");
                assert_eq!(new_name, "oslo");
                assert_eq!(branch.as_deref(), Some("lc/oslo"));
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn cli_parses_workspace_timeline_filter() {
        let parse = Cli::try_parse_from([
            "archductor",
            "workspace",
            "timeline",
            "berlin",
            "--kind",
            "branch.renamed",
        ])
        .unwrap();

        match parse.command {
            Command::Workspace {
                command: WorkspaceCommand::Timeline { workspace, kind },
            } => {
                assert_eq!(workspace, "berlin");
                assert_eq!(kind.as_deref(), Some("branch.renamed"));
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn timeline_render_outputs_append_only_rows() {
        let text = render_workspace_timeline(&[WorkspaceTimelineEvent {
            id: 7,
            workspace_id: 2,
            workspace_name: "berlin".to_owned(),
            kind: "branch.renamed".to_owned(),
            summary: "Renamed branch lc/a to lc/b".to_owned(),
            created_at: "2026-07-09T12:00:00Z".to_owned(),
        }]);

        assert_eq!(
            text,
            "#7\t2026-07-09T12:00:00Z\tbranch.renamed\tRenamed branch lc/a to lc/b\n"
        );
    }

    fn provider_interaction_fixture() -> ProviderInteractionRecord {
        ProviderInteractionRecord {
            id: "interaction-1".to_owned(),
            provider_key: "claude".to_owned(),
            workspace: "berlin".to_owned(),
            thread_id: 42,
            session_id: 7,
            native_session_id: Some("claude-session-1".to_owned()),
            native_id: "toolu-1".to_owned(),
            kind: archductor_core::archcar::harness_contract::ProviderInteractionKind::UserQuestion,
            title: "Need input".to_owned(),
            detail: "Pick a scope".to_owned(),
            questions: vec![
                archductor_core::archcar::harness_contract::InteractionQuestion {
                    id: "scope".to_owned(),
                    header: "Scope".to_owned(),
                    question: "Pick a scope".to_owned(),
                    options: ["yes", "no"]
                        .into_iter()
                        .map(|label| {
                            archductor_core::archcar::harness_contract::InteractionOption {
                                label: label.to_owned(),
                                description: String::new(),
                            }
                        })
                        .collect(),
                    allow_other: false,
                    multi_select: false,
                },
            ],
            auto_resolution_ms: None,
            plan_path: None,
            native_request: serde_json::json!({"secret": "raw"}),
            request_fingerprint: "fingerprint".to_owned(),
            status: archductor_core::provider_interactions::ProviderInteractionStatus::Pending,
            resolution: None,
            native_response: None,
            error: None,
            created_at: "1".to_owned(),
            resolved_at: None,
            consumed_at: None,
        }
    }
}
