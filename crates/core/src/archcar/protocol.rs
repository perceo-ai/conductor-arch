use serde::{Deserialize, Serialize};

use crate::archcar::harness_contract::HarnessDescriptor;
use crate::archcar::harness_contract::{ProviderInteractionDraft, ProviderInteractionResolution};
use crate::background_tasks::{BackgroundTask, StartBackgroundTask};
use crate::codex_tui::{CodexContextUsage, CodexInlineEvent};
use crate::doctor::SetupReport;
use crate::provider_events::ProviderEventRecord;
use crate::provider_interactions::ProviderInteractionRecord;
use crate::service::{InstallService, ServiceStatus};
use crate::session_state::AgentSessionState;
use crate::workspace::{
    ChatEventRecord, ChatMessageRecord, Checkpoint, DiffFileSummary, ReviewComment,
    SessionHarnessOptions, SessionKind, Todo,
};
use crate::workspace_intel::{
    ContextAttachment, DiffContribution, SessionContribution, SessionOverlap, SessionRunRecord,
    Summary, Task, TaskUpdate,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RpcEnvelope<T> {
    pub id: String,
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArchcarInputKind {
    User,
    ReviewPrompt,
    ControlCommand,
    RawTerminal,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArchcarInputDelivery {
    #[default]
    Auto,
    Immediate,
}

impl ArchcarInputDelivery {
    fn is_auto(&self) -> bool {
        *self == Self::Auto
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Immediate => "immediate",
        }
    }
}

/// Which set of file changes a workspace-changes query returns.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceChangeScope {
    /// All changes against the review base ref (working tree vs base).
    All,
    /// Uncommitted staged + unstaged + untracked changes.
    Uncommitted,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceGitAction {
    CreatePr,
    PushBranch,
    MergePr,
    OpenPr,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ArchcarRequest {
    EnsureWorkspaceDefaultSession {
        workspace: String,
        kind: SessionKind,
        harness: Option<SessionHarnessOptions>,
    },
    EnsureChatThreadSession {
        workspace: String,
        thread_id: i64,
        kind: SessionKind,
        harness: Option<SessionHarnessOptions>,
    },
    SpawnSession {
        workspace: String,
        kind: SessionKind,
        harness: Option<SessionHarnessOptions>,
    },
    SendInput {
        session_id: i64,
        input: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        visible_input: Option<String>,
        kind: ArchcarInputKind,
        #[serde(default, skip_serializing_if = "ArchcarInputDelivery::is_auto")]
        delivery: ArchcarInputDelivery,
    },
    InterruptTurn {
        session_id: i64,
    },
    SetSessionModel {
        session_id: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    SetSessionEffort {
        session_id: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
    },
    SetSessionPermissionMode {
        session_id: i64,
        mode: String,
    },
    ResizeSession {
        session_id: i64,
        rows: u16,
        cols: u16,
    },
    GetSessionStatus {
        session_id: i64,
    },
    GetSessionScreen {
        session_id: i64,
    },
    GetSessionMessages {
        thread_id: i64,
    },
    GetChatSnapshot {
        thread_id: i64,
    },
    QueueChatInput {
        thread_id: i64,
        input: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        visible_input: Option<String>,
        kind: ArchcarInputKind,
        session_kind: SessionKind,
    },
    ListQueuedChatInputs {
        thread_id: i64,
    },
    RemoveQueuedChatInput {
        queue_id: i64,
    },
    /// Reorder a queued chat input one slot up (toward the front) or down.
    MoveQueuedChatInput {
        queue_id: i64,
        up: bool,
    },
    /// Save a large pasted blob under the thread's workspace
    /// (.context/archductor/{thread_id}/) so the composer can reference it as a
    /// file attachment instead of inlining a huge string.
    SaveChatPaste {
        thread_id: i64,
        text: String,
    },
    KillSession {
        session_id: i64,
    },
    ListWorkspaces,
    ListRepositories,
    ListChatThreads {
        workspace: String,
    },
    GetChatProjection {
        thread_id: i64,
    },
    ListWorkspaceFiles {
        workspace: String,
    },
    ReadWorkspaceFile {
        workspace: String,
        path: String,
    },
    WriteWorkspaceFile {
        workspace: String,
        path: String,
        content: String,
    },
    GetWorkspaceChanges {
        workspace: String,
        scope: WorkspaceChangeScope,
    },
    GetWorkspaceDiff {
        workspace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    ListTodos {
        workspace: String,
    },
    AddTodo {
        workspace: String,
        text: String,
    },
    ListCheckpoints {
        workspace: String,
    },
    CreateCheckpoint {
        workspace: String,
        message: String,
    },
    /// Diff a checkpoint against the current working tree.
    CompareCheckpoint {
        workspace: String,
        checkpoint_id: i64,
    },
    RestoreCheckpoint {
        workspace: String,
        checkpoint_id: i64,
    },
    GetWorkspaceProcesses {
        workspace: String,
    },
    /// List a workspace's timeline events (lifecycle history).
    ListWorkspaceTimeline {
        workspace: String,
    },
    /// List sibling workspaces that conflict with this one (overlapping files).
    ListWorkspaceConflicts {
        workspace: String,
    },
    /// List directories linked from other workspaces into this one.
    ListLinkedDirectories {
        workspace: String,
    },
    /// Recent commit oneline log for a workspace's branch.
    GetRecentCommits {
        workspace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u32>,
    },
    /// A heuristic draft commit message from the workspace's changed files.
    GetCommitMessageDraft {
        workspace: String,
    },
    /// Show a single commit's stat + patch (git show) for a workspace.
    GetCommitDiff {
        workspace: String,
        commit: String,
    },
    /// Start the workspace's configured run script as a tracked process.
    RunWorkspaceScript {
        workspace: String,
    },
    /// Stop the workspace's currently running run process.
    StopWorkspaceScript {
        workspace: String,
    },
    /// Read the latest run-script log for a workspace.
    GetRunLog {
        workspace: String,
    },
    /// List the repository's configured check commands for a workspace.
    ListWorkspaceChecks {
        workspace: String,
    },
    /// Run one configured check (by key) as a tracked process.
    RunWorkspaceCheck {
        workspace: String,
        key: String,
    },
    /// Read the latest check-process log for a workspace.
    GetCheckLog {
        workspace: String,
    },
    /// PR readiness detail from GitHub (`gh pr view`): CI/status checks, review
    /// decision, deployments, review threads. Requires `gh` auth + an open PR.
    GetPullRequestReadiness {
        workspace: String,
    },
    GetWorkspaceGitActionPrompt {
        workspace: String,
        action: WorkspaceGitAction,
    },
    /// Spotlight testing: current status for a workspace (is its patch applied
    /// to the repo root for live testing).
    GetSpotlightStatus {
        workspace: String,
    },
    /// Start spotlight testing — apply the workspace's tracked changes to the
    /// repository root so the running app reflects them.
    StartSpotlight {
        workspace: String,
    },
    /// Stop spotlight testing — revert the repository root.
    StopSpotlight {
        workspace: String,
    },
    /// Commit the workspace's changes with a message; `stage_all` runs
    /// `git add -A` first, otherwise only already-staged files are committed.
    CommitWorkspaceChanges {
        workspace: String,
        message: String,
        #[serde(default)]
        stage_all: bool,
    },
    GetWorkspaceScriptPrompt {
        workspace: String,
        kind: String,
    },
    GetWorkspaceRunScripts {
        workspace: String,
    },
    StartWorkspaceSetup {
        workspace: String,
    },
    StartWorkspaceRun {
        workspace: String,
    },
    StopWorkspaceRun {
        workspace: String,
    },
    RecoverWorkspaceLifecycleJobs,
    ListReviewComments {
        workspace: String,
    },
    GetChecksSummary {
        workspace: String,
    },
    GetSettings {
        /// Repository name for repo-scoped settings; None = global app settings.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repository: Option<String>,
    },
    /// List a repository's local branch names (base-branch options).
    ListRepositoryBranches {
        repository: String,
    },
    /// List the prompt-pack names available for a repository and which is active.
    ListPromptPacks {
        repository: String,
    },
    /// Set the active prompt pack for a repository (writes committed settings);
    /// responds with the refreshed PromptPacks list.
    SetActivePromptPack {
        repository: String,
        pack: String,
    },
    /// Read the raw, editable source TOML for one settings layer (not the merged
    /// effective view). `repository` None = global app-shared; otherwise the
    /// repository's own committed (`repository`) or `local` override layer.
    GetSettingsSource {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repository: Option<String>,
        /// "repository" (default) or "local"; ignored for global scope.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layer: Option<String>,
    },
    /// Overwrite one settings layer's source TOML. Validates before writing.
    SaveSettings {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repository: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layer: Option<String>,
        toml: String,
    },
    /// Probe host setup readiness (GitHub CLI + agent providers). `recheck`
    /// refreshes the process environment before probing so a just-installed
    /// tool is picked up.
    GetSetupReadiness {
        #[serde(default)]
        recheck: bool,
    },
    CreateChatThread {
        workspace: String,
        provider: String,
        title: String,
    },
    CloseChatThread {
        thread_id: i64,
    },
    ReopenChatThread {
        thread_id: i64,
    },
    // --- Repository & workspace lifecycle (parity with in-process GTK flows) ---
    AddRepository {
        /// Local path to an existing git repository (or subdirectory of one).
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        remote_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_parent: Option<String>,
    },
    CloneRepository {
        url: String,
        /// Destination directory to clone into. The cloned repo is then added.
        dest: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    /// Drop a repository registration (and its workspace records) from the
    /// database without touching the filesystem. Used to prune a repository
    /// whose root path no longer exists on disk.
    RemoveRepository {
        repository: String,
    },
    CreateWorkspace {
        repository: String,
        name: String,
        branch: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_ref: Option<String>,
    },
    CreateWorkspaceFromPrompt {
        repository: String,
        prompt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_ref: Option<String>,
    },
    CreateWorkspaceFromIssue {
        repository: String,
        issue_number: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch_prefix: Option<String>,
    },
    CreateWorkspaceFromPullRequest {
        repository: String,
        pr_number: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
    CreateWorkspaceFromLinear {
        repository: String,
        issue_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_ref: Option<String>,
    },
    ArchiveWorkspace {
        workspace: String,
        #[serde(default)]
        remove_worktree: bool,
    },
    RestoreWorkspace {
        workspace: String,
    },
    RenameWorkspace {
        workspace: String,
        new_name: String,
    },
    DuplicateWorkspace {
        workspace: String,
        new_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
    DeleteWorkspace {
        workspace: String,
        #[serde(default)]
        remove_worktree: bool,
        #[serde(default)]
        delete_branch: bool,
    },
    // --- Branch, PR, review, checkpoint, linking, provider default ----------
    CreateBranch {
        workspace: String,
        branch: String,
    },
    CheckoutBranch {
        workspace: String,
        branch: String,
    },
    RenameWorkspaceBranch {
        workspace: String,
        new_branch: String,
    },
    DeleteBranch {
        workspace: String,
        branch: String,
    },
    PushBranch {
        workspace: String,
        /// Force-push with lease (git `--force-with-lease`) instead of a plain
        /// push. Defaults to a plain push.
        #[serde(default)]
        force: bool,
    },
    RefreshPullRequest {
        workspace: String,
    },
    CreatePullRequest {
        workspace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body: Option<String>,
        #[serde(default)]
        draft: bool,
    },
    GetPullRequestDraft {
        workspace: String,
    },
    ResolveReviewThread {
        workspace: String,
        thread_id: String,
        /// true resolves the thread, false reopens it.
        resolved: bool,
    },
    MergePullRequest {
        workspace: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        method: Option<String>,
    },
    AddReviewComment {
        workspace: String,
        file_path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line_number: Option<i64>,
        body: String,
    },
    DeleteCheckpoint {
        workspace: String,
        checkpoint_id: i64,
    },
    LinkWorkspaceDirectory {
        workspace: String,
        target: String,
    },
    UnlinkWorkspaceDirectory {
        workspace: String,
        target: String,
    },
    SetDefaultAgentProvider {
        workspace: String,
        provider: String,
    },
    RegisterProviderInteraction {
        interaction: ProviderInteractionDraft,
    },
    GetProviderInteraction {
        interaction_id: String,
    },
    ListProviderInteractions {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<i64>,
        pending_only: bool,
    },
    ResolveProviderInteraction {
        interaction_id: String,
        resolution: ProviderInteractionResolution,
    },
    ConsumeProviderInteraction {
        interaction_id: String,
        native_response: serde_json::Value,
    },
    // ---- Daemon service and remote access ---------------------------------
    GetServiceStatus,
    InstallService {
        input: InstallService,
    },
    UninstallService,
    /// Remote access details for setting up a client on another machine.
    GetRemoteAccess,
    RotateRemoteToken,
    // ---- Background development tasks -------------------------------------
    StartBackgroundTask {
        input: StartBackgroundTask,
    },
    ListBackgroundTasks {
        #[serde(default)]
        active_only: bool,
    },
    GetBackgroundTask {
        background_task_id: i64,
    },
    CancelBackgroundTask {
        background_task_id: i64,
    },
    /// Advance every active background task once, without waiting for the
    /// daemon's next supervisor tick.
    TickBackgroundTasks,
    // ---- Workspace intelligence: tasks, summaries, context ----------------
    ListTasks {
        workspace: String,
    },
    CreateTask {
        workspace: String,
        title: String,
        #[serde(default)]
        body: String,
        #[serde(default)]
        intended_areas: Vec<String>,
    },
    UpdateTask {
        workspace: String,
        task_id: i64,
        update: TaskUpdate,
    },
    DeleteTask {
        workspace: String,
        task_id: i64,
    },
    AssignSessionTask {
        workspace: String,
        session_id: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<i64>,
    },
    SetSessionIntendedAreas {
        workspace: String,
        session_id: i64,
        areas: Vec<String>,
    },
    ListSummaries {
        workspace: String,
    },
    SaveSummary {
        workspace: String,
        scope_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope_id: Option<i64>,
        body_markdown: String,
        #[serde(default)]
        source_refs: Vec<String>,
    },
    DeleteSummary {
        workspace: String,
        summary_id: i64,
    },
    DraftSummary {
        workspace: String,
        /// `None` drafts the workspace summary; `Some(id)` drafts that
        /// session's handoff summary.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<i64>,
    },
    ListContextAttachments {
        workspace: String,
    },
    AddContextAttachment {
        workspace: String,
        source: String,
        kind: String,
        body_or_ref: String,
        #[serde(default)]
        scope: String,
        #[serde(default)]
        pinned: bool,
    },
    RemoveContextAttachment {
        workspace: String,
        attachment_id: i64,
    },
    ListSessionContributions {
        workspace: String,
    },
    ListSessionOverlaps {
        workspace: String,
    },
    /// The commands/checks/runs the daemon executed for one session.
    ListSessionRuns {
        workspace: String,
        session_id: i64,
    },
    /// Persist a durable snapshot of one session's diff contribution.
    SnapshotDiffContribution {
        workspace: String,
        session_id: i64,
        #[serde(default)]
        risks: Vec<String>,
        #[serde(default)]
        blockers: Vec<String>,
    },
    /// The stored per-session diff contributions for a workspace.
    ListDiffContributions {
        workspace: String,
    },
    Subscribe,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum ArchcarResponse {
    Ack,
    SessionSpawnQueued {
        workspace: String,
        kind: SessionKind,
    },
    SessionSpawned {
        session_id: i64,
        thread_id: i64,
        workspace: String,
        kind: SessionKind,
        pid: u32,
    },
    SessionStatus {
        session_id: i64,
        status: String,
        runtime_state: AgentSessionState,
        ready: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capabilities: Option<SessionHarnessCapabilities>,
    },
    SessionScreen {
        session_id: i64,
        screen: String,
    },
    SessionMessages {
        thread_id: i64,
        messages: Vec<ArchcarMessage>,
    },
    ChatSnapshot {
        snapshot: ArchcarChatSnapshot,
    },
    QueuedChatInput {
        input: QueuedArchcarInput,
    },
    ChatPasteSaved {
        relative_path: String,
        label: String,
    },
    QueuedChatInputs {
        thread_id: i64,
        inputs: Vec<QueuedArchcarInput>,
    },
    Workspaces {
        workspaces: Vec<ArchcarWorkspaceSummary>,
    },
    Repositories {
        repositories: Vec<ArchcarRepositorySummary>,
    },
    ChatThreads {
        workspace: String,
        threads: Vec<ArchcarChatThread>,
    },
    ChatProjection {
        thread_id: i64,
        items: Vec<ArchcarProjectionItem>,
    },
    WorkspaceFiles {
        workspace: String,
        files: Vec<String>,
    },
    WorkspaceFileContent {
        workspace: String,
        path: String,
        content: String,
    },
    WorkspaceFileWritten {
        workspace: String,
        path: String,
    },
    WorkspaceChanges {
        workspace: String,
        scope: WorkspaceChangeScope,
        files: Vec<DiffFileSummary>,
    },
    WorkspaceDiff {
        workspace: String,
        diff: String,
    },
    Todos {
        workspace: String,
        todos: Vec<Todo>,
    },
    TodoAdded {
        todo: Todo,
    },
    Checkpoints {
        workspace: String,
        checkpoints: Vec<Checkpoint>,
    },
    CheckpointSaved {
        checkpoint: Checkpoint,
    },
    CheckpointDiff {
        workspace: String,
        checkpoint_id: i64,
        diff: String,
        truncated: bool,
    },
    WorkspaceProcesses {
        workspace: String,
        text: String,
    },
    WorkspaceTimeline {
        workspace: String,
        events: Vec<ArchcarTimelineEvent>,
    },
    WorkspaceConflicts {
        workspace: String,
        conflicts: Vec<ArchcarWorkspaceConflict>,
    },
    LinkedDirectories {
        workspace: String,
        directories: Vec<ArchcarLinkedDirectory>,
    },
    RecentCommits {
        workspace: String,
        log: String,
    },
    CommitMessageDraft {
        workspace: String,
        message: String,
    },
    CommitDiff {
        workspace: String,
        commit: String,
        diff: String,
    },
    RunScriptStarted {
        workspace: String,
        pid: u32,
        log_path: String,
    },
    RunScriptStopped {
        workspace: String,
        pid: u32,
    },
    RunLog {
        workspace: String,
        log: String,
    },
    WorkspaceChecks {
        workspace: String,
        checks: Vec<ArchcarConfiguredCheck>,
    },
    CheckStarted {
        workspace: String,
        key: String,
        pid: u32,
        log_path: String,
    },
    CheckLog {
        workspace: String,
        log: String,
    },
    WorkspaceCommitted {
        workspace: String,
        output: String,
    },
    PullRequestReadiness {
        workspace: String,
        text: String,
    },
    WorkspaceGitActionPrompt {
        workspace: String,
        action: WorkspaceGitAction,
        prompt: String,
        visible_input: String,
    },
    SpotlightStatus {
        workspace: String,
        active: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<String>,
    },
    WorkspaceScriptPrompt {
        workspace: String,
        kind: String,
        prompt: String,
    },
    WorkspaceRunScripts {
        workspace: String,
        scripts: Vec<ArchcarRunScript>,
    },
    WorkspaceProcessStarted {
        workspace: String,
        process: ArchcarProcessSummary,
    },
    WorkspaceProcessStopped {
        workspace: String,
        process: ArchcarProcessSummary,
    },
    WorkspaceLifecycleRecovery {
        recovered: usize,
        reconciled_processes: usize,
    },
    ReviewComments {
        workspace: String,
        comments: Vec<ReviewComment>,
    },
    ChecksSummary {
        workspace: String,
        summary: ArchcarChecksSummary,
    },
    Settings {
        /// "global" or the repository name.
        scope: String,
        /// Effective settings serialized as pretty TOML.
        toml: String,
    },
    RepositoryBranches {
        repository: String,
        branches: Vec<String>,
    },
    PromptPacks {
        repository: String,
        packs: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active: Option<String>,
    },
    SettingsSource {
        /// "global" or the repository name.
        scope: String,
        /// "global", "repository", or "local".
        layer: String,
        /// Raw editable source TOML for that one layer (empty if unset).
        toml: String,
    },
    SettingsSaved {
        scope: String,
        layer: String,
    },
    SetupReadiness {
        report: SetupReport,
    },
    ChatThreadCreated {
        thread: ArchcarChatThread,
    },
    RepositoryAdded {
        name: String,
    },
    RepositoryRemoved {
        name: String,
    },
    WorkspaceCreated {
        name: String,
    },
    WorkspaceUpdated {
        name: String,
    },
    WorkspaceRemoved {
        name: String,
    },
    ReviewCommentAdded {
        comment: ReviewComment,
    },
    ProviderInteraction {
        interaction: ProviderInteractionRecord,
    },
    ProviderInteractions {
        interactions: Vec<ProviderInteractionRecord>,
    },
    PullRequestCreated {
        workspace: String,
        output: String,
    },
    ServiceStatus {
        status: ServiceStatus,
    },
    RemoteAccess {
        /// Address the daemon is currently listening on, when it has a remote
        /// listener.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        listen: Option<String>,
        token: String,
        token_path: String,
    },
    BackgroundTaskSaved {
        task: BackgroundTask,
    },
    BackgroundTasks {
        tasks: Vec<BackgroundTask>,
    },
    PullRequestDraft {
        workspace: String,
        title: String,
        body: String,
    },
    Tasks {
        workspace: String,
        tasks: Vec<Task>,
    },
    TaskSaved {
        task: Task,
    },
    TaskDeleted {
        task_id: i64,
    },
    Summaries {
        workspace: String,
        summaries: Vec<Summary>,
    },
    SummarySaved {
        summary: Summary,
    },
    SummaryDeleted {
        summary_id: i64,
    },
    SummaryDraft {
        workspace: String,
        body_markdown: String,
    },
    ContextAttachments {
        workspace: String,
        attachments: Vec<ContextAttachment>,
    },
    ContextAttachmentAdded {
        attachment: ContextAttachment,
    },
    ContextAttachmentRemoved {
        attachment_id: i64,
    },
    SessionContributions {
        workspace: String,
        contributions: Vec<SessionContribution>,
    },
    SessionOverlaps {
        workspace: String,
        overlaps: Vec<SessionOverlap>,
    },
    SessionRuns {
        workspace: String,
        session_id: i64,
        runs: Vec<SessionRunRecord>,
    },
    DiffContributionSaved {
        contribution: DiffContribution,
    },
    DiffContributions {
        workspace: String,
        contributions: Vec<DiffContribution>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionHarnessCapabilities {
    pub contract_version: u16,
    pub required: Vec<String>,
    pub optional: Vec<SessionCapabilitySupport>,
    pub observed_native: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionCapabilitySupport {
    pub name: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn session_harness_capabilities_for_descriptor(
    descriptor: &HarnessDescriptor,
    observed_native: Vec<String>,
) -> SessionHarnessCapabilities {
    SessionHarnessCapabilities {
        contract_version: descriptor.contract_version,
        required: descriptor
            .required_features
            .iter()
            .map(|feature| feature.as_str().to_owned())
            .collect(),
        optional: descriptor
            .optional_capabilities
            .iter()
            .map(|(capability, support)| SessionCapabilitySupport {
                name: capability.as_str().to_owned(),
                mode: support.as_str().to_owned(),
                reason: support.reason().map(str::to_owned),
            })
            .collect(),
        observed_native,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_event: Option<CodexInlineEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<CodexContextUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueuedArchcarInput {
    pub id: i64,
    pub thread_id: i64,
    pub input: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_input: Option<String>,
    pub kind: ArchcarInputKind,
    pub session_kind: SessionKind,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarChatSnapshot {
    pub thread_id: i64,
    pub messages: Vec<ChatMessageRecord>,
    pub events: Vec<ChatEventRecord>,
    pub provider_events: Vec<ProviderEventRecord>,
    pub queued_inputs: Vec<QueuedArchcarInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_session: Option<ArchcarChatLiveSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarChatLiveSession {
    pub session_id: i64,
    pub status: String,
    pub runtime_state: AgentSessionState,
    pub ready: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<SessionHarnessCapabilities>,
}

/// Flat workspace row for the desktop sidebar (compact projection of
/// `WorkspaceStatusLine`). Heavy nested records (full PR, push state) are
/// reduced to the scalar fields the UI actually renders.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarWorkspaceSummary {
    pub id: i64,
    pub name: String,
    pub repository_name: String,
    pub branch: String,
    pub base_ref: String,
    pub status: String,
    pub open_todos: usize,
    #[serde(default)]
    pub open_tasks: usize,
    #[serde(default)]
    pub blocked_tasks: usize,
    pub active_sessions: usize,
    pub run_running: bool,
    pub changed_files: usize,
    pub diff_additions: usize,
    pub diff_deletions: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_number: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_ahead: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_behind: Option<usize>,
    pub updated_at: String,
}

/// Render-ready projected timeline item (flat projection of
/// provider_projection::ProviderProjectionItem). The heavy projection/dedup
/// logic stays in core so both surfaces render the same conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarProjectionItem {
    pub id: String,
    pub sequence: u64,
    /// Snake-case render class (user_chat, assistant_chat, reasoning_card, …).
    pub render_class: String,
    /// Role/category label ("user", "assistant", "reasoning", "command", …).
    pub role_label: String,
    pub title: String,
    pub body: String,
    pub status: String,
    pub stream_state: String,
}

/// One workspace timeline event (creation, branch change, session lifecycle,
/// PR/check action, commit, archive, …) for the Timeline surface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarTimelineEvent {
    pub id: i64,
    pub kind: String,
    pub summary: String,
    pub created_at: String,
}

/// A directory linked from another workspace into this one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarLinkedDirectory {
    pub target_workspace: String,
    pub link_path: String,
    pub created_at: String,
}

/// A sibling workspace that conflicts with this one, plus the overlapping files.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarWorkspaceConflict {
    pub workspace: String,
    pub files: Vec<String>,
}

/// One configured check command (key/label/command) a workspace can run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarConfiguredCheck {
    pub key: String,
    pub label: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarRunScript {
    pub id: String,
    pub command: String,
    pub available_in: Vec<String>,
    pub default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub runnable_here: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarProcessSummary {
    pub id: i64,
    pub kind: String,
    pub pid: u32,
    pub status: String,
    pub log_path: String,
}

/// Flat DB-only checks summary (compact projection of ChecksSummary; the
/// network `gh pr checks` portion is not included).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarChecksSummary {
    pub workspace: String,
    pub changed_files: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_status: Option<String>,
    pub active_sessions: usize,
    pub open_todos: usize,
    pub total_todos: usize,
    pub open_review_comments: usize,
    pub source_branch_ahead: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_ahead: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_behind: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_number: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_state: Option<String>,
    pub conflicting_workspaces: usize,
}

/// Chat thread row for a workspace's chat-tab strip.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarChatThread {
    pub id: i64,
    pub provider: String,
    pub title: String,
    pub status: String,
    /// Explicit model the session was launched with, when recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

/// Repository row for the desktop sidebar projects list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArchcarRepositorySummary {
    pub id: i64,
    pub name: String,
    pub root_path: String,
    pub default_branch: String,
    pub remote_name: String,
    pub active_workspaces: usize,
    pub total_workspaces: usize,
}

pub fn archcar_request_summary(request: &ArchcarRequest) -> String {
    match request {
        ArchcarRequest::EnsureWorkspaceDefaultSession {
            workspace, kind, ..
        } => {
            format!(
                "ensure_workspace_default_session workspace={workspace} kind={}",
                session_kind_label(*kind)
            )
        }
        ArchcarRequest::EnsureChatThreadSession {
            workspace,
            thread_id,
            kind,
            ..
        } => {
            format!(
                "ensure_chat_thread_session workspace={workspace} thread_id={thread_id} kind={}",
                session_kind_label(*kind)
            )
        }
        ArchcarRequest::SpawnSession {
            workspace, kind, ..
        } => {
            format!(
                "spawn_session workspace={workspace} kind={}",
                session_kind_label(*kind)
            )
        }
        ArchcarRequest::SendInput {
            session_id,
            input,
            visible_input: _,
            kind,
            delivery,
        } => format!(
            "send_input session_id={session_id} kind={} delivery={} chars={}",
            input_kind_label(kind),
            delivery.as_str(),
            input.chars().count()
        ),
        ArchcarRequest::InterruptTurn { session_id } => {
            format!("interrupt_turn session_id={session_id}")
        }
        ArchcarRequest::SetSessionModel { session_id, model } => format!(
            "set_session_model session_id={session_id} model={}",
            if model
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                "set"
            } else {
                "default"
            }
        ),
        ArchcarRequest::SetSessionEffort { session_id, effort } => format!(
            "set_session_effort session_id={session_id} effort={}",
            effort.as_deref().unwrap_or("default")
        ),
        ArchcarRequest::SetSessionPermissionMode { session_id, mode } => {
            format!("set_session_permission_mode session_id={session_id} mode={mode}")
        }
        ArchcarRequest::ResizeSession {
            session_id,
            rows,
            cols,
        } => format!("resize_session session_id={session_id} rows={rows} cols={cols}"),
        ArchcarRequest::GetSessionStatus { session_id } => {
            format!("get_session_status session_id={session_id}")
        }
        ArchcarRequest::GetSessionScreen { session_id } => {
            format!("get_session_screen session_id={session_id}")
        }
        ArchcarRequest::GetSessionMessages { thread_id } => {
            format!("get_session_messages thread_id={thread_id}")
        }
        ArchcarRequest::GetChatSnapshot { thread_id } => {
            format!("get_chat_snapshot thread_id={thread_id}")
        }
        ArchcarRequest::QueueChatInput {
            thread_id,
            input,
            kind,
            session_kind,
            ..
        } => format!(
            "queue_chat_input thread_id={thread_id} kind={} session_kind={} chars={}",
            input_kind_label(kind),
            session_kind_label(*session_kind),
            input.chars().count()
        ),
        ArchcarRequest::ListQueuedChatInputs { thread_id } => {
            format!("list_queued_chat_inputs thread_id={thread_id}")
        }
        ArchcarRequest::RemoveQueuedChatInput { queue_id } => {
            format!("remove_queued_chat_input queue_id={queue_id}")
        }
        ArchcarRequest::MoveQueuedChatInput { queue_id, up } => {
            format!("move_queued_chat_input queue_id={queue_id} up={up}")
        }
        ArchcarRequest::SaveChatPaste { thread_id, text } => {
            format!("save_chat_paste thread_id={thread_id} chars={}", text.chars().count())
        }
        ArchcarRequest::KillSession { session_id } => {
            format!("kill_session session_id={session_id}")
        }
        ArchcarRequest::ListWorkspaces => "list_workspaces".to_owned(),
        ArchcarRequest::ListRepositories => "list_repositories".to_owned(),
        ArchcarRequest::ListChatThreads { workspace } => {
            format!("list_chat_threads workspace={workspace}")
        }
        ArchcarRequest::GetChatProjection { thread_id } => {
            format!("get_chat_projection thread_id={thread_id}")
        }
        ArchcarRequest::ListWorkspaceFiles { workspace } => {
            format!("list_workspace_files workspace={workspace}")
        }
        ArchcarRequest::ReadWorkspaceFile { workspace, path } => {
            format!("read_workspace_file workspace={workspace} path={path}")
        }
        ArchcarRequest::WriteWorkspaceFile {
            workspace,
            path,
            content,
        } => format!(
            "write_workspace_file workspace={workspace} path={path} bytes={}",
            content.len()
        ),
        ArchcarRequest::GetWorkspaceChanges { workspace, scope } => {
            format!("get_workspace_changes workspace={workspace} scope={scope:?}")
        }
        ArchcarRequest::GetWorkspaceDiff { workspace, path } => format!(
            "get_workspace_diff workspace={workspace} path={}",
            path.as_deref().unwrap_or("*")
        ),
        ArchcarRequest::ListTodos { workspace } => format!("list_todos workspace={workspace}"),
        ArchcarRequest::AddTodo { workspace, text } => {
            format!("add_todo workspace={workspace} chars={}", text.chars().count())
        }
        ArchcarRequest::ListCheckpoints { workspace } => {
            format!("list_checkpoints workspace={workspace}")
        }
        ArchcarRequest::CreateCheckpoint { workspace, message } => {
            format!("create_checkpoint workspace={workspace} chars={}", message.chars().count())
        }
        ArchcarRequest::CompareCheckpoint { workspace, checkpoint_id } => {
            format!("compare_checkpoint workspace={workspace} checkpoint_id={checkpoint_id}")
        }
        ArchcarRequest::RestoreCheckpoint { workspace, checkpoint_id } => {
            format!("restore_checkpoint workspace={workspace} checkpoint_id={checkpoint_id}")
        }
        ArchcarRequest::GetWorkspaceProcesses { workspace } => {
            format!("get_workspace_processes workspace={workspace}")
        }
        ArchcarRequest::ListWorkspaceTimeline { workspace } => {
            format!("list_workspace_timeline workspace={workspace}")
        }
        ArchcarRequest::ListWorkspaceConflicts { workspace } => {
            format!("list_workspace_conflicts workspace={workspace}")
        }
        ArchcarRequest::ListLinkedDirectories { workspace } => {
            format!("list_linked_directories workspace={workspace}")
        }
        ArchcarRequest::GetRecentCommits { workspace, limit } => format!(
            "get_recent_commits workspace={workspace} limit={}",
            limit.map(|n| n.to_string()).unwrap_or_else(|| "<default>".to_owned())
        ),
        ArchcarRequest::GetCommitMessageDraft { workspace } => {
            format!("get_commit_message_draft workspace={workspace}")
        }
        ArchcarRequest::GetCommitDiff { workspace, commit } => {
            format!("get_commit_diff workspace={workspace} commit={commit}")
        }
        ArchcarRequest::RunWorkspaceScript { workspace } => {
            format!("run_workspace_script workspace={workspace}")
        }
        ArchcarRequest::StopWorkspaceScript { workspace } => {
            format!("stop_workspace_script workspace={workspace}")
        }
        ArchcarRequest::GetRunLog { workspace } => {
            format!("get_run_log workspace={workspace}")
        }
        ArchcarRequest::ListWorkspaceChecks { workspace } => {
            format!("list_workspace_checks workspace={workspace}")
        }
        ArchcarRequest::RunWorkspaceCheck { workspace, key } => {
            format!("run_workspace_check workspace={workspace} key={key}")
        }
        ArchcarRequest::GetCheckLog { workspace } => {
            format!("get_check_log workspace={workspace}")
        }
        ArchcarRequest::GetPullRequestReadiness { workspace } => {
            format!("get_pull_request_readiness workspace={workspace}")
        }
        ArchcarRequest::GetWorkspaceGitActionPrompt { workspace, action } => format!(
            "get_workspace_git_action_prompt workspace={workspace} action={action:?}"
        ),
        ArchcarRequest::GetSpotlightStatus { workspace } => {
            format!("get_spotlight_status workspace={workspace}")
        }
        ArchcarRequest::StartSpotlight { workspace } => {
            format!("start_spotlight workspace={workspace}")
        }
        ArchcarRequest::StopSpotlight { workspace } => {
            format!("stop_spotlight workspace={workspace}")
        }
        ArchcarRequest::CommitWorkspaceChanges {
            workspace,
            message,
            stage_all,
        } => format!(
            "commit_workspace_changes workspace={workspace} stage_all={stage_all} bytes={}",
            message.len()
        ),
        ArchcarRequest::GetWorkspaceScriptPrompt { workspace, kind } => {
            format!("get_workspace_script_prompt workspace={workspace} kind={kind}")
        }
        ArchcarRequest::GetWorkspaceRunScripts { workspace } => {
            format!("get_workspace_run_scripts workspace={workspace}")
        }
        ArchcarRequest::StartWorkspaceSetup { workspace } => {
            format!("start_workspace_setup workspace={workspace}")
        }
        ArchcarRequest::StartWorkspaceRun { workspace } => {
            format!("start_workspace_run workspace={workspace}")
        }
        ArchcarRequest::StopWorkspaceRun { workspace } => {
            format!("stop_workspace_run workspace={workspace}")
        }
        ArchcarRequest::RecoverWorkspaceLifecycleJobs => {
            "recover_workspace_lifecycle_jobs".to_owned()
        }
        ArchcarRequest::ListReviewComments { workspace } => {
            format!("list_review_comments workspace={workspace}")
        }
        ArchcarRequest::GetChecksSummary { workspace } => {
            format!("get_checks_summary workspace={workspace}")
        }
        ArchcarRequest::GetSettings { repository } => {
            format!("get_settings repository={}", repository.as_deref().unwrap_or("<global>"))
        }
        ArchcarRequest::ListRepositoryBranches { repository } => {
            format!("list_repository_branches repository={repository}")
        }
        ArchcarRequest::ListPromptPacks { repository } => {
            format!("list_prompt_packs repository={repository}")
        }
        ArchcarRequest::SetActivePromptPack { repository, pack } => {
            format!("set_active_prompt_pack repository={repository} pack={pack}")
        }
        ArchcarRequest::GetSettingsSource { repository, layer } => format!(
            "get_settings_source repository={} layer={}",
            repository.as_deref().unwrap_or("<global>"),
            layer.as_deref().unwrap_or("<default>")
        ),
        ArchcarRequest::SaveSettings {
            repository,
            layer,
            toml,
        } => format!(
            "save_settings repository={} layer={} bytes={}",
            repository.as_deref().unwrap_or("<global>"),
            layer.as_deref().unwrap_or("<default>"),
            toml.len()
        ),
        ArchcarRequest::GetSetupReadiness { recheck } => {
            format!("get_setup_readiness recheck={recheck}")
        }
        ArchcarRequest::CreateChatThread { workspace, provider, .. } => {
            format!("create_chat_thread workspace={workspace} provider={provider}")
        }
        ArchcarRequest::CloseChatThread { thread_id } => {
            format!("close_chat_thread thread_id={thread_id}")
        }
        ArchcarRequest::ReopenChatThread { thread_id } => {
            format!("reopen_chat_thread thread_id={thread_id}")
        }
        ArchcarRequest::AddRepository { path, name, .. } => format!(
            "add_repository path={path} name={}",
            name.as_deref().unwrap_or("<derived>")
        ),
        ArchcarRequest::CloneRepository { url, dest, .. } => {
            format!("clone_repository url={url} dest={dest}")
        }
        ArchcarRequest::RemoveRepository { repository } => {
            format!("remove_repository repository={repository}")
        }
        ArchcarRequest::CreateWorkspace {
            repository,
            name,
            branch,
            base_ref,
        } => format!(
            "create_workspace repository={repository} name={name} branch={branch} base={}",
            base_ref.as_deref().unwrap_or("<default>")
        ),
        ArchcarRequest::CreateWorkspaceFromPrompt {
            repository, name, ..
        } => format!(
            "create_workspace_from_prompt repository={repository} name={}",
            name.as_deref().unwrap_or("<derived>")
        ),
        ArchcarRequest::CreateWorkspaceFromIssue {
            repository,
            issue_number,
            ..
        } => format!("create_workspace_from_issue repository={repository} issue={issue_number}"),
        ArchcarRequest::CreateWorkspaceFromPullRequest {
            repository,
            pr_number,
            ..
        } => format!("create_workspace_from_pull_request repository={repository} pr={pr_number}"),
        ArchcarRequest::CreateWorkspaceFromLinear {
            repository,
            issue_id,
            name,
            ..
        } => format!(
            "create_workspace_from_linear repository={repository} issue_id={issue_id} name={}",
            name.as_deref().unwrap_or("<derived>")
        ),
        ArchcarRequest::ArchiveWorkspace {
            workspace,
            remove_worktree,
        } => format!("archive_workspace workspace={workspace} remove_worktree={remove_worktree}"),
        ArchcarRequest::RestoreWorkspace { workspace } => {
            format!("restore_workspace workspace={workspace}")
        }
        ArchcarRequest::RenameWorkspace {
            workspace,
            new_name,
        } => format!("rename_workspace workspace={workspace} new_name={new_name}"),
        ArchcarRequest::DuplicateWorkspace {
            workspace,
            new_name,
            ..
        } => format!("duplicate_workspace workspace={workspace} new_name={new_name}"),
        ArchcarRequest::DeleteWorkspace {
            workspace,
            remove_worktree,
            delete_branch,
        } => format!(
            "delete_workspace workspace={workspace} remove_worktree={remove_worktree} delete_branch={delete_branch}"
        ),
        ArchcarRequest::CreateBranch { workspace, branch } => {
            format!("create_branch workspace={workspace} branch={branch}")
        }
        ArchcarRequest::CheckoutBranch { workspace, branch } => {
            format!("checkout_branch workspace={workspace} branch={branch}")
        }
        ArchcarRequest::RenameWorkspaceBranch {
            workspace,
            new_branch,
        } => format!("rename_workspace_branch workspace={workspace} new_branch={new_branch}"),
        ArchcarRequest::DeleteBranch { workspace, branch } => {
            format!("delete_branch workspace={workspace} branch={branch}")
        }
        ArchcarRequest::PushBranch { workspace, force } => {
            format!("push_branch workspace={workspace} force={force}")
        }
        ArchcarRequest::RefreshPullRequest { workspace } => {
            format!("refresh_pull_request workspace={workspace}")
        }
        ArchcarRequest::ResolveReviewThread {
            workspace,
            thread_id,
            resolved,
        } => format!(
            "resolve_review_thread workspace={workspace} thread_id={thread_id} resolved={resolved}"
        ),
        ArchcarRequest::MergePullRequest { workspace, method } => format!(
            "merge_pull_request workspace={workspace} method={}",
            method.as_deref().unwrap_or("<default>")
        ),
        ArchcarRequest::AddReviewComment {
            workspace,
            file_path,
            line_number,
            body,
        } => format!(
            "add_review_comment workspace={workspace} file={file_path} line={} chars={}",
            line_number.map(|n| n.to_string()).unwrap_or_else(|| "-".to_owned()),
            body.chars().count()
        ),
        ArchcarRequest::DeleteCheckpoint {
            workspace,
            checkpoint_id,
        } => format!("delete_checkpoint workspace={workspace} checkpoint_id={checkpoint_id}"),
        ArchcarRequest::LinkWorkspaceDirectory { workspace, target } => {
            format!("link_workspace_directory workspace={workspace} target={target}")
        }
        ArchcarRequest::UnlinkWorkspaceDirectory { workspace, target } => {
            format!("unlink_workspace_directory workspace={workspace} target={target}")
        }
        ArchcarRequest::SetDefaultAgentProvider {
            workspace,
            provider,
        } => format!("set_default_agent_provider workspace={workspace} provider={provider}"),
        ArchcarRequest::RegisterProviderInteraction { interaction } => format!(
            "register_provider_interaction provider={} session_id={} thread_id={} kind={:?} native_id={} request_bytes={}",
            interaction.provider_key,
            interaction.session_id,
            interaction.thread_id,
            interaction.kind,
            interaction.native_id,
            interaction.native_request.to_string().len()
        ),
        ArchcarRequest::GetProviderInteraction { interaction_id } => {
            format!("get_provider_interaction id={interaction_id}")
        }
        ArchcarRequest::ListProviderInteractions {
            thread_id,
            pending_only,
        } => format!(
            "list_provider_interactions thread_id={thread_id:?} pending_only={pending_only}"
        ),
        ArchcarRequest::ResolveProviderInteraction {
            interaction_id,
            resolution,
        } => format!(
            "resolve_provider_interaction id={interaction_id} {}",
            provider_interaction_resolution_summary(resolution)
        ),
        ArchcarRequest::ConsumeProviderInteraction {
            interaction_id,
            native_response,
        } => format!(
            "consume_provider_interaction id={interaction_id} response_bytes={}",
            native_response.to_string().len()
        ),
        ArchcarRequest::CreatePullRequest {
            workspace,
            title,
            body,
            draft,
        } => format!(
            "create_pull_request workspace={workspace} draft={draft} title_chars={} body_chars={}",
            title.as_deref().unwrap_or_default().chars().count(),
            body.as_deref().unwrap_or_default().chars().count()
        ),
        ArchcarRequest::GetPullRequestDraft { workspace } => {
            format!("get_pull_request_draft workspace={workspace}")
        }
        ArchcarRequest::GetServiceStatus => "get_service_status".to_owned(),
        ArchcarRequest::InstallService { input } => format!(
            "install_service listen={}",
            input.listen.as_deref().unwrap_or("none")
        ),
        ArchcarRequest::UninstallService => "uninstall_service".to_owned(),
        ArchcarRequest::GetRemoteAccess => "get_remote_access".to_owned(),
        ArchcarRequest::RotateRemoteToken => "rotate_remote_token".to_owned(),
        ArchcarRequest::StartBackgroundTask { input } => format!(
            "start_background_task repository={} provider={} open_pr={} prompt_chars={}",
            input.repository,
            input.provider,
            input.open_pr,
            input.prompt.chars().count()
        ),
        ArchcarRequest::ListBackgroundTasks { active_only } => {
            format!("list_background_tasks active_only={active_only}")
        }
        ArchcarRequest::GetBackgroundTask { background_task_id } => {
            format!("get_background_task id={background_task_id}")
        }
        ArchcarRequest::CancelBackgroundTask { background_task_id } => {
            format!("cancel_background_task id={background_task_id}")
        }
        ArchcarRequest::TickBackgroundTasks => "tick_background_tasks".to_owned(),
        ArchcarRequest::ListTasks { workspace } => format!("list_tasks workspace={workspace}"),
        ArchcarRequest::CreateTask {
            workspace, title, ..
        } => format!(
            "create_task workspace={workspace} title_chars={}",
            title.chars().count()
        ),
        ArchcarRequest::UpdateTask {
            workspace,
            task_id,
            update,
        } => format!(
            "update_task workspace={workspace} task={task_id} status={}",
            update.status.as_deref().unwrap_or("unchanged")
        ),
        ArchcarRequest::DeleteTask { workspace, task_id } => {
            format!("delete_task workspace={workspace} task={task_id}")
        }
        ArchcarRequest::AssignSessionTask {
            workspace,
            session_id,
            task_id,
        } => format!(
            "assign_session_task workspace={workspace} session={session_id} task={}",
            task_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "none".to_owned())
        ),
        ArchcarRequest::SetSessionIntendedAreas {
            workspace,
            session_id,
            areas,
        } => format!(
            "set_session_intended_areas workspace={workspace} session={session_id} areas={}",
            areas.len()
        ),
        ArchcarRequest::ListSummaries { workspace } => {
            format!("list_summaries workspace={workspace}")
        }
        ArchcarRequest::SaveSummary {
            workspace,
            scope_type,
            scope_id,
            body_markdown,
            ..
        } => format!(
            "save_summary workspace={workspace} scope={scope_type} scope_id={} chars={}",
            scope_id.unwrap_or(0),
            body_markdown.chars().count()
        ),
        ArchcarRequest::DeleteSummary {
            workspace,
            summary_id,
        } => format!("delete_summary workspace={workspace} summary={summary_id}"),
        ArchcarRequest::DraftSummary {
            workspace,
            session_id,
        } => format!(
            "draft_summary workspace={workspace} session={}",
            session_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "none".to_owned())
        ),
        ArchcarRequest::ListContextAttachments { workspace } => {
            format!("list_context_attachments workspace={workspace}")
        }
        ArchcarRequest::AddContextAttachment {
            workspace,
            source,
            kind,
            body_or_ref,
            ..
        } => format!(
            "add_context_attachment workspace={workspace} source={source} kind={kind} chars={}",
            body_or_ref.chars().count()
        ),
        ArchcarRequest::RemoveContextAttachment {
            workspace,
            attachment_id,
        } => format!("remove_context_attachment workspace={workspace} attachment={attachment_id}"),
        ArchcarRequest::ListSessionContributions { workspace } => {
            format!("list_session_contributions workspace={workspace}")
        }
        ArchcarRequest::ListSessionOverlaps { workspace } => {
            format!("list_session_overlaps workspace={workspace}")
        }
        ArchcarRequest::ListSessionRuns {
            workspace,
            session_id,
        } => format!("list_session_runs workspace={workspace} session={session_id}"),
        ArchcarRequest::SnapshotDiffContribution {
            workspace,
            session_id,
            risks,
            blockers,
        } => format!(
            "snapshot_diff_contribution workspace={workspace} session={session_id} risks={} blockers={}",
            risks.len(),
            blockers.len()
        ),
        ArchcarRequest::ListDiffContributions { workspace } => {
            format!("list_diff_contributions workspace={workspace}")
        }
        ArchcarRequest::Subscribe => "subscribe".to_owned(),
    }
}

fn provider_interaction_resolution_summary(resolution: &ProviderInteractionResolution) -> String {
    match resolution {
        ProviderInteractionResolution::Approve => "resolution=approve".to_owned(),
        ProviderInteractionResolution::Deny { reason } => format!(
            "resolution=deny denial_reason_chars={}",
            reason.as_deref().unwrap_or_default().chars().count()
        ),
        ProviderInteractionResolution::Answer { answers } => format!(
            "resolution=answer answer_count={} answer_chars={}",
            answers.len(),
            answers
                .iter()
                .map(|(_, answer)| answer.chars().count())
                .sum::<usize>()
        ),
        ProviderInteractionResolution::Defer => "resolution=defer".to_owned(),
    }
}

pub fn archcar_response_summary(response: &ArchcarResponse) -> String {
    match response {
        ArchcarResponse::Ack => "ack".to_owned(),
        ArchcarResponse::SessionSpawnQueued { workspace, kind } => format!(
            "session_spawn_queued workspace={workspace} kind={}",
            session_kind_label(*kind)
        ),
        ArchcarResponse::SessionSpawned {
            session_id,
            thread_id,
            workspace,
            kind,
            pid,
        } => format!(
            "session_spawned workspace={workspace} kind={} session_id={session_id} thread_id={thread_id} pid={pid}",
            session_kind_label(*kind)
        ),
        ArchcarResponse::SessionStatus {
            session_id,
            status,
            runtime_state,
            ready,
            capabilities: _,
        } => format!(
            "session_status session_id={session_id} status={status} state={} ready={ready}",
            runtime_state.as_str()
        ),
        ArchcarResponse::SessionScreen { session_id, screen } => format!(
            "session_screen session_id={session_id} chars={}",
            screen.chars().count()
        ),
        ArchcarResponse::SessionMessages { thread_id, messages } => format!(
            "session_messages thread_id={thread_id} count={}",
            messages.len()
        ),
        ArchcarResponse::ChatSnapshot { snapshot } => format!(
            "chat_snapshot thread_id={} messages={} events={} provider_events={} queued_inputs={} live_session={}",
            snapshot.thread_id,
            snapshot.messages.len(),
            snapshot.events.len(),
            snapshot.provider_events.len(),
            snapshot.queued_inputs.len(),
            snapshot.live_session.is_some()
        ),
        ArchcarResponse::QueuedChatInput { input } => {
            format!("queued_chat_input id={} thread_id={}", input.id, input.thread_id)
        }
        ArchcarResponse::QueuedChatInputs { thread_id, inputs } => {
            format!("queued_chat_inputs thread_id={thread_id} count={}", inputs.len())
        }
        ArchcarResponse::Workspaces { workspaces } => {
            format!("workspaces count={}", workspaces.len())
        }
        ArchcarResponse::Repositories { repositories } => {
            format!("repositories count={}", repositories.len())
        }
        ArchcarResponse::ChatThreads { workspace, threads } => {
            format!("chat_threads workspace={workspace} count={}", threads.len())
        }
        ArchcarResponse::ChatProjection { thread_id, items } => {
            format!("chat_projection thread_id={thread_id} items={}", items.len())
        }
        ArchcarResponse::WorkspaceFiles { workspace, files } => {
            format!("workspace_files workspace={workspace} count={}", files.len())
        }
        ArchcarResponse::WorkspaceFileContent {
            workspace,
            path,
            content,
        } => format!(
            "workspace_file_content workspace={workspace} path={path} bytes={}",
            content.len()
        ),
        ArchcarResponse::WorkspaceFileWritten { workspace, path } => {
            format!("workspace_file_written workspace={workspace} path={path}")
        }
        ArchcarResponse::WorkspaceChanges { workspace, files, .. } => {
            format!("workspace_changes workspace={workspace} count={}", files.len())
        }
        ArchcarResponse::WorkspaceDiff { workspace, diff } => {
            format!("workspace_diff workspace={workspace} bytes={}", diff.len())
        }
        ArchcarResponse::Todos { workspace, todos } => {
            format!("todos workspace={workspace} count={}", todos.len())
        }
        ArchcarResponse::TodoAdded { todo } => format!("todo_added id={}", todo.id),
        ArchcarResponse::Checkpoints { workspace, checkpoints } => {
            format!("checkpoints workspace={workspace} count={}", checkpoints.len())
        }
        ArchcarResponse::CheckpointSaved { checkpoint } => {
            format!("checkpoint_saved id={}", checkpoint.id)
        }
        ArchcarResponse::CheckpointDiff {
            workspace,
            checkpoint_id,
            diff,
            truncated,
        } => format!(
            "checkpoint_diff workspace={workspace} checkpoint_id={checkpoint_id} chars={} truncated={truncated}",
            diff.chars().count()
        ),
        ArchcarResponse::WorkspaceProcesses { workspace, text } => {
            format!("workspace_processes workspace={workspace} bytes={}", text.len())
        }
        ArchcarResponse::WorkspaceTimeline { workspace, events } => {
            format!("workspace_timeline workspace={workspace} count={}", events.len())
        }
        ArchcarResponse::WorkspaceConflicts { workspace, conflicts } => {
            format!("workspace_conflicts workspace={workspace} count={}", conflicts.len())
        }
        ArchcarResponse::LinkedDirectories { workspace, directories } => {
            format!("linked_directories workspace={workspace} count={}", directories.len())
        }
        ArchcarResponse::RecentCommits { workspace, log } => {
            format!("recent_commits workspace={workspace} bytes={}", log.len())
        }
        ArchcarResponse::CommitMessageDraft { workspace, message } => {
            format!("commit_message_draft workspace={workspace} bytes={}", message.len())
        }
        ArchcarResponse::CommitDiff { workspace, commit, diff } => {
            format!("commit_diff workspace={workspace} commit={commit} bytes={}", diff.len())
        }
        ArchcarResponse::RunScriptStarted { workspace, pid, log_path } => {
            format!("run_script_started workspace={workspace} pid={pid} log={log_path}")
        }
        ArchcarResponse::RunScriptStopped { workspace, pid } => {
            format!("run_script_stopped workspace={workspace} pid={pid}")
        }
        ArchcarResponse::WorkspaceChecks { workspace, checks } => {
            format!("workspace_checks workspace={workspace} count={}", checks.len())
        }
        ArchcarResponse::CheckStarted { workspace, key, pid, log_path } => {
            format!("check_started workspace={workspace} key={key} pid={pid} log={log_path}")
        }
        ArchcarResponse::CheckLog { workspace, log } => {
            format!("check_log workspace={workspace} bytes={}", log.len())
        }
        ArchcarResponse::WorkspaceCommitted { workspace, output } => {
            format!("workspace_committed workspace={workspace} bytes={}", output.len())
        }
        ArchcarResponse::PullRequestReadiness { workspace, text } => {
            format!("pull_request_readiness workspace={workspace} bytes={}", text.len())
        }
        ArchcarResponse::WorkspaceGitActionPrompt {
            workspace,
            action,
            prompt,
            ..
        } => format!(
            "workspace_git_action_prompt workspace={workspace} action={action:?} bytes={}",
            prompt.len()
        ),
        ArchcarResponse::SpotlightStatus { workspace, active, .. } => {
            format!("spotlight_status workspace={workspace} active={active}")
        }
        ArchcarResponse::RunLog { workspace, log } => {
            format!("run_log workspace={workspace} bytes={}", log.len())
        }
        ArchcarResponse::WorkspaceScriptPrompt { workspace, kind, prompt } => {
            format!("workspace_script_prompt workspace={workspace} kind={kind} bytes={}", prompt.len())
        }
        ArchcarResponse::WorkspaceRunScripts { workspace, scripts } => {
            format!("workspace_run_scripts workspace={workspace} count={}", scripts.len())
        }
        ArchcarResponse::WorkspaceProcessStarted { workspace, process } => {
            format!("workspace_process_started workspace={workspace} kind={} pid={}", process.kind, process.pid)
        }
        ArchcarResponse::WorkspaceProcessStopped { workspace, process } => {
            format!("workspace_process_stopped workspace={workspace} kind={} pid={}", process.kind, process.pid)
        }
        ArchcarResponse::WorkspaceLifecycleRecovery {
            recovered,
            reconciled_processes,
        } => {
            format!("workspace_lifecycle_recovery recovered={recovered} reconciled_processes={reconciled_processes}")
        }
        ArchcarResponse::ReviewComments { workspace, comments } => {
            format!("review_comments workspace={workspace} count={}", comments.len())
        }
        ArchcarResponse::ChecksSummary { workspace, .. } => {
            format!("checks_summary workspace={workspace}")
        }
        ArchcarResponse::RepositoryBranches { repository, branches } => {
            format!("repository_branches repository={repository} count={}", branches.len())
        }
        ArchcarResponse::PromptPacks { repository, packs, active } => format!(
            "prompt_packs repository={repository} count={} active={}",
            packs.len(),
            active.as_deref().unwrap_or("<none>")
        ),
        ArchcarResponse::SettingsSource { scope, layer, toml } => {
            format!("settings_source scope={scope} layer={layer} bytes={}", toml.len())
        }
        ArchcarResponse::SettingsSaved { scope, layer } => {
            format!("settings_saved scope={scope} layer={layer}")
        }
        ArchcarResponse::Settings { scope, toml } => {
            format!("settings scope={scope} bytes={}", toml.len())
        }
        ArchcarResponse::SetupReadiness { report } => {
            format!(
                "setup_readiness complete={} rows={}",
                report.complete,
                report.rows.len()
            )
        }
        ArchcarResponse::ChatThreadCreated { thread } => {
            format!("chat_thread_created id={}", thread.id)
        }
        ArchcarResponse::RepositoryAdded { name } => format!("repository_added name={name}"),
        ArchcarResponse::RepositoryRemoved { name } => format!("repository_removed name={name}"),
        ArchcarResponse::ChatPasteSaved { relative_path, .. } => {
            format!("chat_paste_saved path={relative_path}")
        }
        ArchcarResponse::WorkspaceCreated { name } => format!("workspace_created name={name}"),
        ArchcarResponse::WorkspaceUpdated { name } => format!("workspace_updated name={name}"),
        ArchcarResponse::WorkspaceRemoved { name } => format!("workspace_removed name={name}"),
        ArchcarResponse::ReviewCommentAdded { comment } => {
            format!("review_comment_added id={}", comment.id)
        }
        ArchcarResponse::ProviderInteraction { interaction } => format!(
            "provider_interaction id={} kind={:?} status={:?}",
            interaction.id, interaction.kind, interaction.status
        ),
        ArchcarResponse::ProviderInteractions { interactions } => {
            format!("provider_interactions count={}", interactions.len())
        }
        ArchcarResponse::PullRequestCreated { workspace, output } => format!(
            "pull_request_created workspace={workspace} chars={}",
            output.chars().count()
        ),
        ArchcarResponse::PullRequestDraft {
            workspace,
            title,
            body,
        } => format!(
            "pull_request_draft workspace={workspace} title_chars={} body_chars={}",
            title.chars().count(),
            body.chars().count()
        ),
        ArchcarResponse::ServiceStatus { status } => format!(
            "service_status manager={} installed={} running={}",
            status.manager, status.installed, status.running
        ),
        // The token is a credential: report its length, never its value.
        ArchcarResponse::RemoteAccess { listen, token, .. } => format!(
            "remote_access listen={} token_chars={}",
            listen.as_deref().unwrap_or("none"),
            token.chars().count()
        ),
        ArchcarResponse::BackgroundTaskSaved { task } => format!(
            "background_task_saved id={} status={} workspace={}",
            task.id,
            task.status,
            task.workspace_name.as_deref().unwrap_or("-")
        ),
        ArchcarResponse::BackgroundTasks { tasks } => {
            format!("background_tasks count={}", tasks.len())
        }
        ArchcarResponse::Tasks { workspace, tasks } => {
            format!("tasks workspace={workspace} count={}", tasks.len())
        }
        ArchcarResponse::TaskSaved { task } => {
            format!("task_saved id={} status={}", task.id, task.status)
        }
        ArchcarResponse::TaskDeleted { task_id } => format!("task_deleted id={task_id}"),
        ArchcarResponse::Summaries {
            workspace,
            summaries,
        } => format!("summaries workspace={workspace} count={}", summaries.len()),
        ArchcarResponse::SummarySaved { summary } => format!(
            "summary_saved id={} scope={} chars={}",
            summary.id,
            summary.scope_type,
            summary.body_markdown.chars().count()
        ),
        ArchcarResponse::SummaryDeleted { summary_id } => {
            format!("summary_deleted id={summary_id}")
        }
        ArchcarResponse::SummaryDraft {
            workspace,
            body_markdown,
        } => format!(
            "summary_draft workspace={workspace} chars={}",
            body_markdown.chars().count()
        ),
        ArchcarResponse::ContextAttachments {
            workspace,
            attachments,
        } => format!(
            "context_attachments workspace={workspace} count={}",
            attachments.len()
        ),
        ArchcarResponse::ContextAttachmentAdded { attachment } => format!(
            "context_attachment_added id={} source={} kind={}",
            attachment.id, attachment.source, attachment.kind
        ),
        ArchcarResponse::ContextAttachmentRemoved { attachment_id } => {
            format!("context_attachment_removed id={attachment_id}")
        }
        ArchcarResponse::SessionContributions {
            workspace,
            contributions,
        } => format!(
            "session_contributions workspace={workspace} count={}",
            contributions.len()
        ),
        ArchcarResponse::SessionOverlaps {
            workspace,
            overlaps,
        } => format!(
            "session_overlaps workspace={workspace} count={}",
            overlaps.len()
        ),
        ArchcarResponse::SessionRuns {
            workspace,
            session_id,
            runs,
        } => format!(
            "session_runs workspace={workspace} session={session_id} count={}",
            runs.len()
        ),
        ArchcarResponse::DiffContributionSaved { contribution } => format!(
            "diff_contribution_saved session={} files={}",
            contribution.session_id,
            contribution.files.len()
        ),
        ArchcarResponse::DiffContributions {
            workspace,
            contributions,
        } => format!(
            "diff_contributions workspace={workspace} count={}",
            contributions.len()
        ),
        ArchcarResponse::Error { message } => {
            format!("error chars={}", message.chars().count())
        }
    }
}

pub fn archcar_event_summary(event: &ArchcarEvent) -> String {
    match event {
        ArchcarEvent::SessionSpawnQueued { workspace, kind } => format!(
            "session_spawn_queued workspace={workspace} kind={}",
            session_kind_label(*kind)
        ),
        ArchcarEvent::SessionStarted {
            session_id,
            thread_id,
            workspace,
            kind,
            pid,
        } => format!(
            "session_started workspace={workspace} kind={} session_id={session_id} thread_id={thread_id} pid={pid}",
            session_kind_label(*kind)
        ),
        ArchcarEvent::SessionReady {
            session_id,
            thread_id,
        } => format!("session_ready session_id={session_id} thread_id={thread_id}"),
        ArchcarEvent::SessionCapabilitiesChanged {
            session_id,
            thread_id,
            capabilities,
        } => format!(
            "session_capabilities_changed session_id={session_id} thread_id={thread_id} required={} optional={} observed_native={}",
            capabilities.required.len(),
            capabilities.optional.len(),
            capabilities.observed_native.len()
        ),
        ArchcarEvent::TurnCompleted {
            session_id,
            thread_id,
            status,
        } => format!(
            "turn_completed session_id={session_id} thread_id={thread_id} status={}",
            status.as_deref().unwrap_or("unknown")
        ),
        ArchcarEvent::SessionScreenUpdated { session_id } => {
            format!("session_screen_updated session_id={session_id}")
        }
        ArchcarEvent::SessionMessagesUpdated { thread_id } => {
            format!("session_messages_updated thread_id={thread_id}")
        }
        ArchcarEvent::ChatQueueUpdated { thread_id } => {
            format!("chat_queue_updated thread_id={thread_id}")
        }
        ArchcarEvent::SessionExited {
            session_id,
            exit_code,
        } => format!("session_exited session_id={session_id} exit_code={exit_code:?}"),
        ArchcarEvent::SessionError {
            session_id,
            thread_id,
            message,
        } => format!(
            "session_error session_id={session_id:?} thread_id={thread_id:?} chars={}",
            message.chars().count()
        ),
        ArchcarEvent::ProviderInteractionRequested { interaction } => format!(
            "provider_interaction_requested id={} kind={:?} status={:?}",
            interaction.id, interaction.kind, interaction.status
        ),
        ArchcarEvent::ProviderInteractionResolved { interaction } => format!(
            "provider_interaction_resolved id={} kind={:?} status={:?}",
            interaction.id, interaction.kind, interaction.status
        ),
        ArchcarEvent::BackgroundTaskUpdated { task } => format!(
            "background_task_updated id={} status={}",
            task.id, task.status
        ),
    }
}

fn session_kind_label(kind: SessionKind) -> &'static str {
    match kind {
        SessionKind::Shell => "Shell",
        SessionKind::Codex => "Codex",
        SessionKind::Claude => "Claude",
    }
}

fn input_kind_label(kind: &ArchcarInputKind) -> &'static str {
    match kind {
        ArchcarInputKind::User => "user",
        ArchcarInputKind::ReviewPrompt => "review_prompt",
        ArchcarInputKind::ControlCommand => "control_command",
        ArchcarInputKind::RawTerminal => "raw_terminal",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ArchcarEvent {
    SessionSpawnQueued {
        workspace: String,
        kind: SessionKind,
    },
    SessionStarted {
        session_id: i64,
        thread_id: i64,
        workspace: String,
        kind: SessionKind,
        pid: u32,
    },
    SessionReady {
        session_id: i64,
        thread_id: i64,
    },
    SessionCapabilitiesChanged {
        session_id: i64,
        thread_id: i64,
        capabilities: SessionHarnessCapabilities,
    },
    TurnCompleted {
        session_id: i64,
        thread_id: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
    },
    SessionScreenUpdated {
        session_id: i64,
    },
    SessionMessagesUpdated {
        thread_id: i64,
    },
    ChatQueueUpdated {
        thread_id: i64,
    },
    SessionExited {
        session_id: i64,
        exit_code: Option<i32>,
    },
    SessionError {
        session_id: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<i64>,
        message: String,
    },
    ProviderInteractionRequested {
        interaction: ProviderInteractionRecord,
    },
    ProviderInteractionResolved {
        interaction: ProviderInteractionRecord,
    },
    /// A background development task advanced (including reaching a terminal
    /// state), so clients can update their strips and notify the user.
    BackgroundTaskUpdated {
        task: BackgroundTask,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archcar::harness_contract::{
        ProviderInteractionKind, ProviderInteractionResolution,
    };
    use crate::codex_tui::{CodexContextUsage, CodexInlineEvent, CodexToolCall};
    use crate::provider_interactions::ProviderInteractionStatus;

    #[test]
    fn protocol_round_trips_spawn_event() {
        let envelope = RpcEnvelope {
            id: "1".to_owned(),
            payload: ArchcarEvent::SessionStarted {
                session_id: 4,
                thread_id: 6,
                workspace: "berlin".to_owned(),
                kind: SessionKind::Codex,
                pid: 123,
            },
        };
        let json = serde_json::to_string(&envelope).unwrap();
        let decoded: RpcEnvelope<ArchcarEvent> = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, envelope);
    }

    #[test]
    fn request_summary_describes_send_input() {
        let request = ArchcarRequest::SendInput {
            session_id: 9,
            input: "run tests".to_owned(),
            visible_input: None,
            kind: ArchcarInputKind::User,
            delivery: ArchcarInputDelivery::Immediate,
        };

        assert_eq!(
            archcar_request_summary(&request),
            "send_input session_id=9 kind=user delivery=immediate chars=9"
        );
    }

    #[test]
    fn send_input_delivery_defaults_to_auto_and_round_trips_immediate() {
        let legacy = r#"{"type":"send_input","session_id":9,"input":"run tests","kind":"user"}"#;
        let decoded: ArchcarRequest = serde_json::from_str(legacy).unwrap();
        let ArchcarRequest::SendInput { delivery, .. } = decoded else {
            panic!("expected send input");
        };
        assert_eq!(delivery, ArchcarInputDelivery::Auto);

        let immediate = ArchcarRequest::SendInput {
            session_id: 9,
            input: "adjust course".to_owned(),
            visible_input: None,
            kind: ArchcarInputKind::User,
            delivery: ArchcarInputDelivery::Immediate,
        };
        let json = serde_json::to_string(&immediate).unwrap();
        assert!(json.contains("\"delivery\":\"immediate\""));
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&json).unwrap(),
            immediate
        );
    }

    #[test]
    fn queued_chat_input_protocol_round_trips() {
        let request = ArchcarRequest::QueueChatInput {
            thread_id: 42,
            input: "run tests".to_owned(),
            visible_input: Some("visible run tests".to_owned()),
            kind: ArchcarInputKind::User,
            session_kind: SessionKind::Codex,
        };
        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("\"type\":\"queue_chat_input\""));
        assert_eq!(
            archcar_request_summary(&request),
            "queue_chat_input thread_id=42 kind=user session_kind=Codex chars=9"
        );
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&json).unwrap(),
            request
        );

        let event = ArchcarEvent::ChatQueueUpdated { thread_id: 42 };
        assert_eq!(
            archcar_event_summary(&event),
            "chat_queue_updated thread_id=42"
        );
        assert_eq!(
            serde_json::from_str::<ArchcarEvent>(&serde_json::to_string(&event).unwrap()).unwrap(),
            event
        );

        for visible_input in [Some("visible run tests".to_owned()), None] {
            let queued = QueuedArchcarInput {
                id: 7,
                thread_id: 42,
                input: "run tests".to_owned(),
                visible_input: visible_input.clone(),
                kind: ArchcarInputKind::User,
                session_kind: SessionKind::Codex,
                created_at: "2026-07-23T12:00:00Z".to_owned(),
                updated_at: "2026-07-23T12:00:01Z".to_owned(),
            };
            let json = serde_json::to_string(&queued).unwrap();
            assert_eq!(
                serde_json::from_str::<QueuedArchcarInput>(&json).unwrap(),
                queued
            );

            let response = ArchcarResponse::QueuedChatInput {
                input: queued.clone(),
            };
            let json = serde_json::to_string(&response).unwrap();
            assert_eq!(
                serde_json::from_str::<ArchcarResponse>(&json).unwrap(),
                response
            );

            let list = ArchcarResponse::QueuedChatInputs {
                thread_id: 42,
                inputs: vec![queued],
            };
            let json = serde_json::to_string(&list).unwrap();
            assert_eq!(
                serde_json::from_str::<ArchcarResponse>(&json).unwrap(),
                list
            );
        }
    }

    #[test]
    fn request_summary_describes_and_round_trips_set_session_model() {
        let request = ArchcarRequest::SetSessionModel {
            session_id: 9,
            model: Some("gpt-5.6-terra".to_owned()),
        };

        assert_eq!(
            archcar_request_summary(&request),
            "set_session_model session_id=9 model=set"
        );
        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("\"type\":\"set_session_model\""));
        let decoded: ArchcarRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, request);

        let reset = ArchcarRequest::SetSessionModel {
            session_id: 9,
            model: None,
        };
        assert_eq!(
            archcar_request_summary(&reset),
            "set_session_model session_id=9 model=default"
        );
        let json = serde_json::to_string(&reset).unwrap();
        assert!(!json.contains("\"model\""));
        let decoded: ArchcarRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, reset);
    }

    #[test]
    fn set_session_effort_and_permission_mode_requests_round_trip() {
        let effort = ArchcarRequest::SetSessionEffort {
            session_id: 7,
            effort: Some("high".to_owned()),
        };
        assert_eq!(
            archcar_request_summary(&effort),
            "set_session_effort session_id=7 effort=high"
        );
        let json = serde_json::to_string(&effort).unwrap();
        assert!(json.contains("\"type\":\"set_session_effort\""));
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&json).unwrap(),
            effort
        );

        let permission = ArchcarRequest::SetSessionPermissionMode {
            session_id: 7,
            mode: "default".to_owned(),
        };
        assert_eq!(
            archcar_request_summary(&permission),
            "set_session_permission_mode session_id=7 mode=default"
        );
        let json = serde_json::to_string(&permission).unwrap();
        assert!(json.contains("\"type\":\"set_session_permission_mode\""));
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&json).unwrap(),
            permission
        );
    }

    #[test]
    fn request_summary_describes_resize_session() {
        let request = ArchcarRequest::ResizeSession {
            session_id: 9,
            rows: 33,
            cols: 111,
        };

        assert_eq!(
            archcar_request_summary(&request),
            "resize_session session_id=9 rows=33 cols=111"
        );
    }

    #[test]
    fn provider_interaction_protocol_round_trips_and_summarizes_without_bodies() {
        let request = ArchcarRequest::RegisterProviderInteraction {
            interaction: ProviderInteractionDraft {
                provider_key: "claude".to_owned(),
                workspace: "berlin".to_owned(),
                thread_id: 7,
                session_id: 11,
                native_session_id: Some("session-1".to_owned()),
                native_id: "tool-1".to_owned(),
                kind: ProviderInteractionKind::UserQuestion,
                title: "Question".to_owned(),
                detail: "secret detail".to_owned(),
                choices: vec!["yes".to_owned()],
                native_request: serde_json::json!({"prompt":"secret"}),
            },
        };

        let summary = archcar_request_summary(&request);
        assert!(summary.contains("register_provider_interaction"));
        assert!(summary.contains("request_bytes="));
        assert!(!summary.contains("secret"));

        let json = serde_json::to_string(&request).unwrap();
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&json).unwrap(),
            request
        );

        let resolve = ArchcarRequest::ResolveProviderInteraction {
            interaction_id: "interaction-1".to_owned(),
            resolution: ProviderInteractionResolution::Deny {
                reason: Some("contains secret token".to_owned()),
            },
        };
        let resolve_summary = archcar_request_summary(&resolve);
        assert!(resolve_summary.contains("interaction-1"));
        assert!(resolve_summary.contains("resolution=deny"));
        assert!(resolve_summary.contains("denial_reason_chars="));
        assert!(!resolve_summary.contains("secret"));
    }

    #[test]
    fn provider_interaction_event_summary_reports_identity_and_status() {
        let interaction = ProviderInteractionRecord {
            id: "interaction-1".to_owned(),
            provider_key: "claude".to_owned(),
            workspace: "berlin".to_owned(),
            thread_id: 7,
            session_id: 11,
            native_session_id: None,
            native_id: "tool-1".to_owned(),
            kind: ProviderInteractionKind::Permission,
            title: "Permission".to_owned(),
            detail: "secret".to_owned(),
            choices: Vec::new(),
            native_request: serde_json::json!({"secret": true}),
            request_fingerprint: "abc".to_owned(),
            status: ProviderInteractionStatus::Pending,
            resolution: None,
            native_response: None,
            error: None,
            created_at: "1".to_owned(),
            resolved_at: None,
            consumed_at: None,
        };
        let event = ArchcarEvent::ProviderInteractionRequested {
            interaction: interaction.clone(),
        };

        let summary = archcar_event_summary(&event);
        assert!(summary.contains("interaction-1"));
        assert!(summary.contains("Pending"));
        assert!(!summary.contains("secret"));
        assert_eq!(
            serde_json::from_str::<ArchcarEvent>(&serde_json::to_string(&event).unwrap()).unwrap(),
            event
        );
    }

    #[test]
    fn lifecycle_requests_round_trip_and_summarize() {
        let cases: Vec<(ArchcarRequest, &str, &str)> = vec![
            (
                ArchcarRequest::AddRepository {
                    path: "/tmp/repo".to_owned(),
                    name: Some("repo".to_owned()),
                    remote_name: None,
                    default_branch: None,
                    workspace_parent: None,
                },
                "\"type\":\"add_repository\"",
                "add_repository path=/tmp/repo name=repo",
            ),
            (
                ArchcarRequest::CloneRepository {
                    url: "git@example.com:o/r.git".to_owned(),
                    dest: "/tmp/r".to_owned(),
                    name: None,
                },
                "\"type\":\"clone_repository\"",
                "clone_repository url=git@example.com:o/r.git dest=/tmp/r",
            ),
            (
                ArchcarRequest::CreateWorkspace {
                    repository: "repo".to_owned(),
                    name: "ws".to_owned(),
                    branch: "feature".to_owned(),
                    base_ref: Some("main".to_owned()),
                },
                "\"type\":\"create_workspace\"",
                "create_workspace repository=repo name=ws branch=feature base=main",
            ),
            (
                ArchcarRequest::CreateWorkspaceFromPrompt {
                    repository: "repo".to_owned(),
                    prompt: "do the thing".to_owned(),
                    name: None,
                    branch: None,
                    base_ref: None,
                },
                "\"type\":\"create_workspace_from_prompt\"",
                "create_workspace_from_prompt repository=repo name=<derived>",
            ),
            (
                ArchcarRequest::CreateWorkspaceFromIssue {
                    repository: "repo".to_owned(),
                    issue_number: 42,
                    branch_prefix: None,
                },
                "\"type\":\"create_workspace_from_issue\"",
                "create_workspace_from_issue repository=repo issue=42",
            ),
            (
                ArchcarRequest::CreateWorkspaceFromLinear {
                    repository: "repo".to_owned(),
                    issue_id: "ENG-123".to_owned(),
                    name: None,
                    branch: None,
                    base_ref: None,
                },
                "\"type\":\"create_workspace_from_linear\"",
                "create_workspace_from_linear repository=repo issue_id=ENG-123 name=<derived>",
            ),
            (
                ArchcarRequest::CreateWorkspaceFromPullRequest {
                    repository: "repo".to_owned(),
                    pr_number: 7,
                    name: None,
                    branch: None,
                },
                "\"type\":\"create_workspace_from_pull_request\"",
                "create_workspace_from_pull_request repository=repo pr=7",
            ),
            (
                ArchcarRequest::CreateWorkspaceFromLinear {
                    repository: "repo".to_owned(),
                    issue_id: "ARC-123".to_owned(),
                    name: None,
                    branch: None,
                    base_ref: None,
                },
                "\"type\":\"create_workspace_from_linear\"",
                "create_workspace_from_linear repository=repo issue_id=ARC-123 name=<derived>",
            ),
            (
                ArchcarRequest::ArchiveWorkspace {
                    workspace: "ws".to_owned(),
                    remove_worktree: true,
                },
                "\"type\":\"archive_workspace\"",
                "archive_workspace workspace=ws remove_worktree=true",
            ),
            (
                ArchcarRequest::RestoreWorkspace {
                    workspace: "ws".to_owned(),
                },
                "\"type\":\"restore_workspace\"",
                "restore_workspace workspace=ws",
            ),
            (
                ArchcarRequest::RenameWorkspace {
                    workspace: "ws".to_owned(),
                    new_name: "ws2".to_owned(),
                },
                "\"type\":\"rename_workspace\"",
                "rename_workspace workspace=ws new_name=ws2",
            ),
            (
                ArchcarRequest::DuplicateWorkspace {
                    workspace: "ws".to_owned(),
                    new_name: "ws-copy".to_owned(),
                    branch: None,
                },
                "\"type\":\"duplicate_workspace\"",
                "duplicate_workspace workspace=ws new_name=ws-copy",
            ),
            (
                ArchcarRequest::DeleteWorkspace {
                    workspace: "ws".to_owned(),
                    remove_worktree: true,
                    delete_branch: false,
                },
                "\"type\":\"delete_workspace\"",
                "delete_workspace workspace=ws remove_worktree=true delete_branch=false",
            ),
        ];

        for (request, type_tag, summary) in cases {
            let json = serde_json::to_string(&request).unwrap();
            assert!(json.contains(type_tag), "missing {type_tag} in {json}");
            assert_eq!(
                serde_json::from_str::<ArchcarRequest>(&json).unwrap(),
                request
            );
            assert_eq!(archcar_request_summary(&request), summary);
        }
    }

    #[test]
    fn file_and_settings_requests_round_trip_and_summarize() {
        let cases: Vec<(ArchcarRequest, &str, &str)> = vec![
            (
                ArchcarRequest::ReadWorkspaceFile {
                    workspace: "ws".to_owned(),
                    path: "src/a.rs".to_owned(),
                },
                "\"type\":\"read_workspace_file\"",
                "read_workspace_file workspace=ws path=src/a.rs",
            ),
            (
                ArchcarRequest::WriteWorkspaceFile {
                    workspace: "ws".to_owned(),
                    path: "src/a.rs".to_owned(),
                    content: "hello".to_owned(),
                },
                "\"type\":\"write_workspace_file\"",
                "write_workspace_file workspace=ws path=src/a.rs bytes=5",
            ),
            (
                ArchcarRequest::GetSettingsSource {
                    repository: Some("repo".to_owned()),
                    layer: Some("local".to_owned()),
                },
                "\"type\":\"get_settings_source\"",
                "get_settings_source repository=repo layer=local",
            ),
            (
                ArchcarRequest::GetSettingsSource {
                    repository: None,
                    layer: None,
                },
                "\"type\":\"get_settings_source\"",
                "get_settings_source repository=<global> layer=<default>",
            ),
            (
                ArchcarRequest::SaveSettings {
                    repository: None,
                    layer: None,
                    toml: "x = 1".to_owned(),
                },
                "\"type\":\"save_settings\"",
                "save_settings repository=<global> layer=<default> bytes=5",
            ),
        ];

        for (request, type_tag, summary) in cases {
            let json = serde_json::to_string(&request).unwrap();
            assert!(json.contains(type_tag), "missing {type_tag} in {json}");
            assert_eq!(
                serde_json::from_str::<ArchcarRequest>(&json).unwrap(),
                request
            );
            assert_eq!(archcar_request_summary(&request), summary);
        }
    }

    #[test]
    fn run_script_requests_and_responses_round_trip_and_summarize() {
        let requests: Vec<(ArchcarRequest, &str, &str)> = vec![
            (
                ArchcarRequest::RunWorkspaceScript {
                    workspace: "ws".to_owned(),
                },
                "\"type\":\"run_workspace_script\"",
                "run_workspace_script workspace=ws",
            ),
            (
                ArchcarRequest::StopWorkspaceScript {
                    workspace: "ws".to_owned(),
                },
                "\"type\":\"stop_workspace_script\"",
                "stop_workspace_script workspace=ws",
            ),
            (
                ArchcarRequest::GetRunLog {
                    workspace: "ws".to_owned(),
                },
                "\"type\":\"get_run_log\"",
                "get_run_log workspace=ws",
            ),
        ];
        for (request, type_tag, summary) in requests {
            let json = serde_json::to_string(&request).unwrap();
            assert!(json.contains(type_tag), "missing {type_tag} in {json}");
            assert_eq!(
                serde_json::from_str::<ArchcarRequest>(&json).unwrap(),
                request
            );
            assert_eq!(archcar_request_summary(&request), summary);
        }

        let responses: Vec<(ArchcarResponse, &str, &str)> = vec![
            (
                ArchcarResponse::RunScriptStarted {
                    workspace: "ws".to_owned(),
                    pid: 4321,
                    log_path: "/tmp/run.log".to_owned(),
                },
                "\"type\":\"run_script_started\"",
                "run_script_started workspace=ws pid=4321 log=/tmp/run.log",
            ),
            (
                ArchcarResponse::RunScriptStopped {
                    workspace: "ws".to_owned(),
                    pid: 4321,
                },
                "\"type\":\"run_script_stopped\"",
                "run_script_stopped workspace=ws pid=4321",
            ),
            (
                ArchcarResponse::RunLog {
                    workspace: "ws".to_owned(),
                    log: "hello".to_owned(),
                },
                "\"type\":\"run_log\"",
                "run_log workspace=ws bytes=5",
            ),
        ];
        for (response, type_tag, summary) in responses {
            let json = serde_json::to_string(&response).unwrap();
            assert!(json.contains(type_tag), "missing {type_tag} in {json}");
            assert_eq!(
                serde_json::from_str::<ArchcarResponse>(&json).unwrap(),
                response
            );
            assert_eq!(archcar_response_summary(&response), summary);
        }
    }

    #[test]
    fn workspace_timeline_round_trips_and_summarizes() {
        let req = ArchcarRequest::ListWorkspaceTimeline {
            workspace: "ws".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&req).unwrap()).unwrap(),
            req
        );
        assert_eq!(
            archcar_request_summary(&req),
            "list_workspace_timeline workspace=ws"
        );

        let resp = ArchcarResponse::WorkspaceTimeline {
            workspace: "ws".to_owned(),
            events: vec![ArchcarTimelineEvent {
                id: 3,
                kind: "commit.created".to_owned(),
                summary: "Committed staged changes".to_owned(),
                created_at: "2026-08-06T00:00:00Z".to_owned(),
            }],
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&resp).unwrap())
                .unwrap(),
            resp
        );
        assert_eq!(
            archcar_response_summary(&resp),
            "workspace_timeline workspace=ws count=1"
        );

        let creq = ArchcarRequest::ListWorkspaceConflicts {
            workspace: "ws".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&creq).unwrap()).unwrap(),
            creq
        );
        assert_eq!(
            archcar_request_summary(&creq),
            "list_workspace_conflicts workspace=ws"
        );
        let cresp = ArchcarResponse::WorkspaceConflicts {
            workspace: "ws".to_owned(),
            conflicts: vec![ArchcarWorkspaceConflict {
                workspace: "sibling".to_owned(),
                files: vec!["a.rs".to_owned(), "b.rs".to_owned()],
            }],
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&cresp).unwrap())
                .unwrap(),
            cresp
        );
        assert_eq!(
            archcar_response_summary(&cresp),
            "workspace_conflicts workspace=ws count=1"
        );

        let lreq = ArchcarRequest::ListLinkedDirectories {
            workspace: "ws".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&lreq).unwrap()).unwrap(),
            lreq
        );
        assert_eq!(
            archcar_request_summary(&lreq),
            "list_linked_directories workspace=ws"
        );
        let lresp = ArchcarResponse::LinkedDirectories {
            workspace: "ws".to_owned(),
            directories: vec![ArchcarLinkedDirectory {
                target_workspace: "sib".to_owned(),
                link_path: ".context/linked-directories/sib".to_owned(),
                created_at: "2026-08-06T00:00:00Z".to_owned(),
            }],
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&lresp).unwrap())
                .unwrap(),
            lresp
        );
        assert_eq!(
            archcar_response_summary(&lresp),
            "linked_directories workspace=ws count=1"
        );
    }

    #[test]
    fn recent_commits_round_trips_and_summarizes() {
        let req = ArchcarRequest::GetRecentCommits {
            workspace: "ws".to_owned(),
            limit: Some(10),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&req).unwrap()).unwrap(),
            req
        );
        assert_eq!(
            archcar_request_summary(&req),
            "get_recent_commits workspace=ws limit=10"
        );
        let req_default = ArchcarRequest::GetRecentCommits {
            workspace: "ws".to_owned(),
            limit: None,
        };
        assert_eq!(
            archcar_request_summary(&req_default),
            "get_recent_commits workspace=ws limit=<default>"
        );

        let resp = ArchcarResponse::RecentCommits {
            workspace: "ws".to_owned(),
            log: "abc123 msg".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&resp).unwrap())
                .unwrap(),
            resp
        );
        assert_eq!(
            archcar_response_summary(&resp),
            "recent_commits workspace=ws bytes=10"
        );

        let draft_req = ArchcarRequest::GetCommitMessageDraft {
            workspace: "ws".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&draft_req).unwrap())
                .unwrap(),
            draft_req
        );
        assert_eq!(
            archcar_request_summary(&draft_req),
            "get_commit_message_draft workspace=ws"
        );
        let draft_resp = ArchcarResponse::CommitMessageDraft {
            workspace: "ws".to_owned(),
            message: "update".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&draft_resp).unwrap())
                .unwrap(),
            draft_resp
        );
        assert_eq!(
            archcar_response_summary(&draft_resp),
            "commit_message_draft workspace=ws bytes=6"
        );

        let show_req = ArchcarRequest::GetCommitDiff {
            workspace: "ws".to_owned(),
            commit: "abc123".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&show_req).unwrap())
                .unwrap(),
            show_req
        );
        assert_eq!(
            archcar_request_summary(&show_req),
            "get_commit_diff workspace=ws commit=abc123"
        );
        let show_resp = ArchcarResponse::CommitDiff {
            workspace: "ws".to_owned(),
            commit: "abc123".to_owned(),
            diff: "patch".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&show_resp).unwrap())
                .unwrap(),
            show_resp
        );
        assert_eq!(
            archcar_response_summary(&show_resp),
            "commit_diff workspace=ws commit=abc123 bytes=5"
        );
    }

    #[test]
    fn spotlight_round_trips_and_summarizes() {
        for (req, summary) in [
            (
                ArchcarRequest::GetSpotlightStatus {
                    workspace: "ws".to_owned(),
                },
                "get_spotlight_status workspace=ws",
            ),
            (
                ArchcarRequest::StartSpotlight {
                    workspace: "ws".to_owned(),
                },
                "start_spotlight workspace=ws",
            ),
            (
                ArchcarRequest::StopSpotlight {
                    workspace: "ws".to_owned(),
                },
                "stop_spotlight workspace=ws",
            ),
        ] {
            assert_eq!(
                serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&req).unwrap())
                    .unwrap(),
                req
            );
            assert_eq!(archcar_request_summary(&req), summary);
        }
        let resp = ArchcarResponse::SpotlightStatus {
            workspace: "ws".to_owned(),
            active: true,
            status: Some("active".to_owned()),
            started_at: Some("123".to_owned()),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&resp).unwrap())
                .unwrap(),
            resp
        );
        assert_eq!(
            archcar_response_summary(&resp),
            "spotlight_status workspace=ws active=true"
        );
    }

    #[test]
    fn pull_request_readiness_round_trips_and_summarizes() {
        let req = ArchcarRequest::GetPullRequestReadiness {
            workspace: "ws".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&req).unwrap()).unwrap(),
            req
        );
        assert_eq!(
            archcar_request_summary(&req),
            "get_pull_request_readiness workspace=ws"
        );
        let resp = ArchcarResponse::PullRequestReadiness {
            workspace: "ws".to_owned(),
            text: "ready".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&resp).unwrap())
                .unwrap(),
            resp
        );
        assert_eq!(
            archcar_response_summary(&resp),
            "pull_request_readiness workspace=ws bytes=5"
        );
    }

    #[test]
    fn commit_workspace_changes_round_trips_and_summarizes() {
        let req = ArchcarRequest::CommitWorkspaceChanges {
            workspace: "ws".to_owned(),
            message: "hello".to_owned(),
            stage_all: true,
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&req).unwrap()).unwrap(),
            req
        );
        assert_eq!(
            archcar_request_summary(&req),
            "commit_workspace_changes workspace=ws stage_all=true bytes=5"
        );

        let resp = ArchcarResponse::WorkspaceCommitted {
            workspace: "ws".to_owned(),
            output: "1 file changed".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&resp).unwrap())
                .unwrap(),
            resp
        );
        assert_eq!(
            archcar_response_summary(&resp),
            "workspace_committed workspace=ws bytes=14"
        );
    }

    #[test]
    fn repository_branches_round_trips_and_summarizes() {
        let req = ArchcarRequest::ListRepositoryBranches {
            repository: "repo".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&req).unwrap()).unwrap(),
            req
        );
        assert_eq!(
            archcar_request_summary(&req),
            "list_repository_branches repository=repo"
        );

        let resp = ArchcarResponse::RepositoryBranches {
            repository: "repo".to_owned(),
            branches: vec!["main".to_owned(), "dev".to_owned()],
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&resp).unwrap())
                .unwrap(),
            resp
        );
        assert_eq!(
            archcar_response_summary(&resp),
            "repository_branches repository=repo count=2"
        );
    }

    #[test]
    fn prompt_pack_list_round_trips_and_summarizes() {
        let req = ArchcarRequest::ListPromptPacks {
            repository: "repo".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&req).unwrap()).unwrap(),
            req
        );
        assert_eq!(
            archcar_request_summary(&req),
            "list_prompt_packs repository=repo"
        );

        let set_req = ArchcarRequest::SetActivePromptPack {
            repository: "repo".to_owned(),
            pack: "rust".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&set_req).unwrap())
                .unwrap(),
            set_req
        );
        assert_eq!(
            archcar_request_summary(&set_req),
            "set_active_prompt_pack repository=repo pack=rust"
        );

        let resp = ArchcarResponse::PromptPacks {
            repository: "repo".to_owned(),
            packs: vec!["default".to_owned(), "rust".to_owned()],
            active: Some("rust".to_owned()),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&resp).unwrap())
                .unwrap(),
            resp
        );
        assert_eq!(
            archcar_response_summary(&resp),
            "prompt_packs repository=repo count=2 active=rust"
        );
    }

    #[test]
    fn check_requests_and_responses_round_trip_and_summarize() {
        let list_req = ArchcarRequest::ListWorkspaceChecks {
            workspace: "ws".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&list_req).unwrap())
                .unwrap(),
            list_req
        );
        assert_eq!(
            archcar_request_summary(&list_req),
            "list_workspace_checks workspace=ws"
        );

        let run_req = ArchcarRequest::RunWorkspaceCheck {
            workspace: "ws".to_owned(),
            key: "lint".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&run_req).unwrap())
                .unwrap(),
            run_req
        );
        assert_eq!(
            archcar_request_summary(&run_req),
            "run_workspace_check workspace=ws key=lint"
        );

        let checks_resp = ArchcarResponse::WorkspaceChecks {
            workspace: "ws".to_owned(),
            checks: vec![ArchcarConfiguredCheck {
                key: "lint".to_owned(),
                label: "Lint".to_owned(),
                command: "npm run lint".to_owned(),
            }],
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&checks_resp).unwrap())
                .unwrap(),
            checks_resp
        );
        assert_eq!(
            archcar_response_summary(&checks_resp),
            "workspace_checks workspace=ws count=1"
        );

        let started = ArchcarResponse::CheckStarted {
            workspace: "ws".to_owned(),
            key: "lint".to_owned(),
            pid: 9,
            log_path: "/t/c.log".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&started).unwrap())
                .unwrap(),
            started
        );
        assert_eq!(
            archcar_response_summary(&started),
            "check_started workspace=ws key=lint pid=9 log=/t/c.log"
        );

        let log_req = ArchcarRequest::GetCheckLog {
            workspace: "ws".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&serde_json::to_string(&log_req).unwrap())
                .unwrap(),
            log_req
        );
        assert_eq!(
            archcar_request_summary(&log_req),
            "get_check_log workspace=ws"
        );

        let log_resp = ArchcarResponse::CheckLog {
            workspace: "ws".to_owned(),
            log: "hello".to_owned(),
        };
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&serde_json::to_string(&log_resp).unwrap())
                .unwrap(),
            log_resp
        );
        assert_eq!(
            archcar_response_summary(&log_resp),
            "check_log workspace=ws bytes=5"
        );
    }

    #[test]
    fn file_and_settings_responses_round_trip_and_summarize() {
        let cases: Vec<(ArchcarResponse, &str, &str)> = vec![
            (
                ArchcarResponse::WorkspaceFileContent {
                    workspace: "ws".to_owned(),
                    path: "a.rs".to_owned(),
                    content: "hello".to_owned(),
                },
                "\"type\":\"workspace_file_content\"",
                "workspace_file_content workspace=ws path=a.rs bytes=5",
            ),
            (
                ArchcarResponse::WorkspaceFileWritten {
                    workspace: "ws".to_owned(),
                    path: "a.rs".to_owned(),
                },
                "\"type\":\"workspace_file_written\"",
                "workspace_file_written workspace=ws path=a.rs",
            ),
            (
                ArchcarResponse::SettingsSource {
                    scope: "global".to_owned(),
                    layer: "global".to_owned(),
                    toml: "x = 1".to_owned(),
                },
                "\"type\":\"settings_source\"",
                "settings_source scope=global layer=global bytes=5",
            ),
            (
                ArchcarResponse::SettingsSaved {
                    scope: "repo".to_owned(),
                    layer: "local".to_owned(),
                },
                "\"type\":\"settings_saved\"",
                "settings_saved scope=repo layer=local",
            ),
        ];

        for (response, type_tag, summary) in cases {
            let json = serde_json::to_string(&response).unwrap();
            assert!(json.contains(type_tag), "missing {type_tag} in {json}");
            assert_eq!(
                serde_json::from_str::<ArchcarResponse>(&json).unwrap(),
                response
            );
            assert_eq!(archcar_response_summary(&response), summary);
        }
    }

    #[test]
    fn branch_pr_review_requests_round_trip_and_summarize() {
        let cases: Vec<(ArchcarRequest, &str, &str)> = vec![
            (
                ArchcarRequest::CreateBranch {
                    workspace: "ws".to_owned(),
                    branch: "feat".to_owned(),
                },
                "\"type\":\"create_branch\"",
                "create_branch workspace=ws branch=feat",
            ),
            (
                ArchcarRequest::CheckoutBranch {
                    workspace: "ws".to_owned(),
                    branch: "feat".to_owned(),
                },
                "\"type\":\"checkout_branch\"",
                "checkout_branch workspace=ws branch=feat",
            ),
            (
                ArchcarRequest::RenameWorkspaceBranch {
                    workspace: "ws".to_owned(),
                    new_branch: "feat2".to_owned(),
                },
                "\"type\":\"rename_workspace_branch\"",
                "rename_workspace_branch workspace=ws new_branch=feat2",
            ),
            (
                ArchcarRequest::DeleteBranch {
                    workspace: "ws".to_owned(),
                    branch: "old".to_owned(),
                },
                "\"type\":\"delete_branch\"",
                "delete_branch workspace=ws branch=old",
            ),
            (
                ArchcarRequest::PushBranch {
                    workspace: "ws".to_owned(),
                    force: false,
                },
                "\"type\":\"push_branch\"",
                "push_branch workspace=ws force=false",
            ),
            (
                ArchcarRequest::PushBranch {
                    workspace: "ws".to_owned(),
                    force: true,
                },
                "\"type\":\"push_branch\"",
                "push_branch workspace=ws force=true",
            ),
            (
                ArchcarRequest::RefreshPullRequest {
                    workspace: "ws".to_owned(),
                },
                "\"type\":\"refresh_pull_request\"",
                "refresh_pull_request workspace=ws",
            ),
            (
                ArchcarRequest::ResolveReviewThread {
                    workspace: "ws".to_owned(),
                    thread_id: "T_123".to_owned(),
                    resolved: true,
                },
                "\"type\":\"resolve_review_thread\"",
                "resolve_review_thread workspace=ws thread_id=T_123 resolved=true",
            ),
            (
                ArchcarRequest::MergePullRequest {
                    workspace: "ws".to_owned(),
                    method: Some("squash".to_owned()),
                },
                "\"type\":\"merge_pull_request\"",
                "merge_pull_request workspace=ws method=squash",
            ),
            (
                ArchcarRequest::AddReviewComment {
                    workspace: "ws".to_owned(),
                    file_path: "src/lib.rs".to_owned(),
                    line_number: Some(12),
                    body: "nit".to_owned(),
                },
                "\"type\":\"add_review_comment\"",
                "add_review_comment workspace=ws file=src/lib.rs line=12 chars=3",
            ),
            (
                ArchcarRequest::DeleteCheckpoint {
                    workspace: "ws".to_owned(),
                    checkpoint_id: 5,
                },
                "\"type\":\"delete_checkpoint\"",
                "delete_checkpoint workspace=ws checkpoint_id=5",
            ),
            (
                ArchcarRequest::LinkWorkspaceDirectory {
                    workspace: "ws".to_owned(),
                    target: "other".to_owned(),
                },
                "\"type\":\"link_workspace_directory\"",
                "link_workspace_directory workspace=ws target=other",
            ),
            (
                ArchcarRequest::UnlinkWorkspaceDirectory {
                    workspace: "ws".to_owned(),
                    target: "other".to_owned(),
                },
                "\"type\":\"unlink_workspace_directory\"",
                "unlink_workspace_directory workspace=ws target=other",
            ),
            (
                ArchcarRequest::SetDefaultAgentProvider {
                    workspace: "ws".to_owned(),
                    provider: "codex".to_owned(),
                },
                "\"type\":\"set_default_agent_provider\"",
                "set_default_agent_provider workspace=ws provider=codex",
            ),
        ];
        for (request, type_tag, summary) in cases {
            let json = serde_json::to_string(&request).unwrap();
            assert!(json.contains(type_tag), "missing {type_tag} in {json}");
            assert_eq!(
                serde_json::from_str::<ArchcarRequest>(&json).unwrap(),
                request
            );
            assert_eq!(archcar_request_summary(&request), summary);
        }
    }

    #[test]
    fn lifecycle_responses_round_trip_and_summarize() {
        let cases: Vec<(ArchcarResponse, &str)> = vec![
            (
                ArchcarResponse::RepositoryAdded {
                    name: "repo".to_owned(),
                },
                "repository_added name=repo",
            ),
            (
                ArchcarResponse::WorkspaceCreated {
                    name: "ws".to_owned(),
                },
                "workspace_created name=ws",
            ),
            (
                ArchcarResponse::WorkspaceUpdated {
                    name: "ws".to_owned(),
                },
                "workspace_updated name=ws",
            ),
            (
                ArchcarResponse::WorkspaceRemoved {
                    name: "ws".to_owned(),
                },
                "workspace_removed name=ws",
            ),
        ];
        for (response, summary) in cases {
            let json = serde_json::to_string(&response).unwrap();
            assert_eq!(
                serde_json::from_str::<ArchcarResponse>(&json).unwrap(),
                response
            );
            assert_eq!(archcar_response_summary(&response), summary);
        }
    }

    #[test]
    fn workspace_run_scripts_protocol_round_trips_without_logging_commands() {
        let request = ArchcarRequest::GetWorkspaceRunScripts {
            workspace: "berlin".to_owned(),
        };
        let response = ArchcarResponse::WorkspaceRunScripts {
            workspace: "berlin".to_owned(),
            scripts: vec![ArchcarRunScript {
                id: "dev".to_owned(),
                command: "pnpm dev --token secret".to_owned(),
                available_in: vec!["local".to_owned()],
                default: true,
                icon: Some("play".to_owned()),
                runnable_here: true,
                unavailable_reason: None,
            }],
        };

        let request_json = serde_json::to_string(&request).unwrap();
        let response_json = serde_json::to_string(&response).unwrap();

        assert!(request_json.contains("\"type\":\"get_workspace_run_scripts\""));
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&request_json).unwrap(),
            request
        );
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&response_json).unwrap(),
            response
        );
        assert_eq!(
            archcar_request_summary(&request),
            "get_workspace_run_scripts workspace=berlin"
        );
        assert_eq!(
            archcar_response_summary(&response),
            "workspace_run_scripts workspace=berlin count=1"
        );
        assert!(!archcar_response_summary(&response).contains("secret"));
    }

    #[test]
    fn workspace_script_start_protocol_round_trips_process_summary() {
        let requests = [
            (
                ArchcarRequest::StartWorkspaceSetup {
                    workspace: "berlin".to_owned(),
                },
                "\"type\":\"start_workspace_setup\"",
                "start_workspace_setup workspace=berlin",
            ),
            (
                ArchcarRequest::StartWorkspaceRun {
                    workspace: "berlin".to_owned(),
                },
                "\"type\":\"start_workspace_run\"",
                "start_workspace_run workspace=berlin",
            ),
            (
                ArchcarRequest::StopWorkspaceRun {
                    workspace: "berlin".to_owned(),
                },
                "\"type\":\"stop_workspace_run\"",
                "stop_workspace_run workspace=berlin",
            ),
        ];
        for (request, tag, summary) in requests {
            let json = serde_json::to_string(&request).unwrap();
            assert!(json.contains(tag), "{json}");
            assert_eq!(
                serde_json::from_str::<ArchcarRequest>(&json).unwrap(),
                request
            );
            assert_eq!(archcar_request_summary(&request), summary);
        }

        let response = ArchcarResponse::WorkspaceProcessStarted {
            workspace: "berlin".to_owned(),
            process: ArchcarProcessSummary {
                id: 7,
                kind: "run".to_owned(),
                pid: 123,
                status: "running".to_owned(),
                log_path: "/tmp/run.log".to_owned(),
            },
        };
        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"type\":\"workspace_process_started\""));
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&json).unwrap(),
            response
        );
        assert_eq!(
            archcar_response_summary(&response),
            "workspace_process_started workspace=berlin kind=run pid=123"
        );

        let stopped = ArchcarResponse::WorkspaceProcessStopped {
            workspace: "berlin".to_owned(),
            process: ArchcarProcessSummary {
                id: 7,
                kind: "run".to_owned(),
                pid: 123,
                status: "stopped".to_owned(),
                log_path: "/tmp/run.log".to_owned(),
            },
        };
        let stopped_json = serde_json::to_string(&stopped).unwrap();
        assert!(stopped_json.contains("\"type\":\"workspace_process_stopped\""));
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&stopped_json).unwrap(),
            stopped
        );
        assert_eq!(
            archcar_response_summary(&stopped),
            "workspace_process_stopped workspace=berlin kind=run pid=123"
        );

        let recovery = ArchcarRequest::RecoverWorkspaceLifecycleJobs;
        let recovery_json = serde_json::to_string(&recovery).unwrap();
        assert!(recovery_json.contains("\"type\":\"recover_workspace_lifecycle_jobs\""));
        assert_eq!(
            serde_json::from_str::<ArchcarRequest>(&recovery_json).unwrap(),
            recovery
        );
        assert_eq!(
            archcar_request_summary(&recovery),
            "recover_workspace_lifecycle_jobs"
        );

        let recovery_response = ArchcarResponse::WorkspaceLifecycleRecovery {
            recovered: 2,
            reconciled_processes: 3,
        };
        let recovery_response_json = serde_json::to_string(&recovery_response).unwrap();
        assert!(recovery_response_json.contains("\"type\":\"workspace_lifecycle_recovery\""));
        assert_eq!(
            serde_json::from_str::<ArchcarResponse>(&recovery_response_json).unwrap(),
            recovery_response
        );
        assert_eq!(
            archcar_response_summary(&recovery_response),
            "workspace_lifecycle_recovery recovered=2 reconciled_processes=3"
        );
    }

    #[test]
    fn request_summary_describes_and_round_trips_interrupt_turn() {
        let request = ArchcarRequest::InterruptTurn { session_id: 9 };

        assert_eq!(
            archcar_request_summary(&request),
            "interrupt_turn session_id=9"
        );
        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("\"type\":\"interrupt_turn\""));
        let decoded: ArchcarRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, request);
    }

    #[test]
    fn archcar_message_skips_absent_codex_metadata_and_round_trips_present_metadata() {
        let message = ArchcarMessage {
            id: 1,
            role: "assistant".to_owned(),
            content: "Running tests".to_owned(),
            source: "codex".to_owned(),
            inline_event: None,
            context_usage: None,
        };
        let json = serde_json::to_string(&message).unwrap();
        assert!(!json.contains("inline_event"));
        assert!(!json.contains("context_usage"));
        let decoded: ArchcarMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, message);

        let message = ArchcarMessage {
            inline_event: Some(CodexInlineEvent::Tool(CodexToolCall {
                namespace: "web".to_owned(),
                name: "run".to_owned(),
                marker: "web.run".to_owned(),
            })),
            context_usage: Some(CodexContextUsage {
                percent: Some(42),
                used_tokens: None,
                total_tokens: None,
            }),
            ..message
        };
        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains("inline_event"));
        assert!(json.contains("context_usage"));
        let decoded: ArchcarMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, message);
    }

    #[test]
    fn response_summary_describes_spawned_session() {
        let response = ArchcarResponse::SessionSpawned {
            session_id: 7,
            thread_id: 3,
            workspace: "hoi-an".to_owned(),
            kind: SessionKind::Codex,
            pid: 4242,
        };

        assert_eq!(
            archcar_response_summary(&response),
            "session_spawned workspace=hoi-an kind=Codex session_id=7 thread_id=3 pid=4242"
        );
    }

    #[test]
    fn response_summaries_omit_screen_and_message_bodies() {
        let screen_response = ArchcarResponse::SessionScreen {
            session_id: 7,
            screen: "prompt with OPENAI_API_KEY=sk-secret".to_owned(),
        };
        let messages_response = ArchcarResponse::SessionMessages {
            thread_id: 3,
            messages: vec![ArchcarMessage {
                id: 1,
                role: "assistant".to_owned(),
                content: "staged review prompt: keep this private".to_owned(),
                source: "agent_screen_parse".to_owned(),
                inline_event: None,
                context_usage: None,
            }],
        };

        let screen_summary = archcar_response_summary(&screen_response);
        let messages_summary = archcar_response_summary(&messages_response);

        assert_eq!(screen_summary, "session_screen session_id=7 chars=36");
        assert_eq!(messages_summary, "session_messages thread_id=3 count=1");
        assert!(!screen_summary.contains("sk-secret"));
        assert!(!messages_summary.contains("staged review prompt"));
    }

    #[test]
    fn event_summary_describes_ready_session() {
        let event = ArchcarEvent::SessionReady {
            session_id: 11,
            thread_id: 5,
        };

        assert_eq!(
            archcar_event_summary(&event),
            "session_ready session_id=11 thread_id=5"
        );
    }

    #[test]
    fn event_summary_describes_completed_turn_boundary() {
        let event = ArchcarEvent::TurnCompleted {
            session_id: 11,
            thread_id: 5,
            status: Some("cancelled".to_owned()),
        };

        assert_eq!(
            archcar_event_summary(&event),
            "turn_completed session_id=11 thread_id=5 status=cancelled"
        );
    }

    #[test]
    fn session_capabilities_event_serializes_descriptor_payload() {
        let capabilities = SessionHarnessCapabilities {
            contract_version: 1,
            required: vec!["preflight".to_owned(), "streaming_events".to_owned()],
            optional: vec![SessionCapabilitySupport {
                name: "goals".to_owned(),
                mode: "native".to_owned(),
                reason: None,
            }],
            observed_native: vec!["streaming".to_owned()],
        };
        let event = ArchcarEvent::SessionCapabilitiesChanged {
            session_id: 11,
            thread_id: 5,
            capabilities: capabilities.clone(),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"session_capabilities_changed\""));
        assert!(json.contains("\"observed_native\":[\"streaming\"]"));
        assert_eq!(serde_json::from_str::<ArchcarEvent>(&json).unwrap(), event);
        assert_eq!(
            archcar_event_summary(&event),
            "session_capabilities_changed session_id=11 thread_id=5 required=2 optional=1 observed_native=1"
        );
    }

    #[test]
    fn session_status_response_carries_typed_runtime_state() {
        let response = ArchcarResponse::SessionStatus {
            session_id: 11,
            status: "running".to_owned(),
            ready: false,
            runtime_state: crate::session_state::AgentSessionState::ToolRunning,
            capabilities: Some(SessionHarnessCapabilities {
                contract_version: 1,
                required: vec!["preflight".to_owned()],
                optional: Vec::new(),
                observed_native: Vec::new(),
            }),
        };

        let encoded = serde_json::to_string(&response).unwrap();

        assert!(encoded.contains("\"runtime_state\":\"tool_running\""));
        assert!(encoded.contains("\"capabilities\""));
        assert_eq!(
            archcar_response_summary(&response),
            "session_status session_id=11 status=running state=tool_running ready=false"
        );
    }

    #[test]
    fn workspace_intelligence_requests_round_trip_and_summarize() {
        let requests = vec![
            ArchcarRequest::ListTasks {
                workspace: "berlin".to_owned(),
            },
            ArchcarRequest::CreateTask {
                workspace: "berlin".to_owned(),
                title: "Wire Context tab".to_owned(),
                body: "local + archivum".to_owned(),
                intended_areas: vec!["desktop/src".to_owned()],
            },
            ArchcarRequest::UpdateTask {
                workspace: "berlin".to_owned(),
                task_id: 4,
                update: TaskUpdate {
                    status: Some("blocked".to_owned()),
                    blocked_reason: Some(Some("needs auth".to_owned())),
                    ..TaskUpdate::default()
                },
            },
            ArchcarRequest::SaveSummary {
                workspace: "berlin".to_owned(),
                scope_type: "session".to_owned(),
                scope_id: Some(9),
                body_markdown: "did things".to_owned(),
                source_refs: vec!["git status".to_owned()],
            },
            ArchcarRequest::DraftSummary {
                workspace: "berlin".to_owned(),
                session_id: None,
            },
            ArchcarRequest::AddContextAttachment {
                workspace: "berlin".to_owned(),
                source: "local".to_owned(),
                kind: "note".to_owned(),
                body_or_ref: "ports are per-workspace".to_owned(),
                scope: String::new(),
                pinned: true,
            },
            ArchcarRequest::ListSessionContributions {
                workspace: "berlin".to_owned(),
            },
            ArchcarRequest::ListSessionOverlaps {
                workspace: "berlin".to_owned(),
            },
        ];

        for request in requests {
            let json = serde_json::to_string(&request).unwrap();
            let decoded: ArchcarRequest = serde_json::from_str(&json).unwrap();
            assert_eq!(decoded, request, "round trip {json}");
        }

        assert_eq!(
            archcar_request_summary(&ArchcarRequest::UpdateTask {
                workspace: "berlin".to_owned(),
                task_id: 4,
                update: TaskUpdate {
                    status: Some("blocked".to_owned()),
                    ..TaskUpdate::default()
                },
            }),
            "update_task workspace=berlin task=4 status=blocked"
        );
    }

    #[test]
    fn workspace_intelligence_responses_summarize_without_bodies() {
        let response = ArchcarResponse::SummaryDraft {
            workspace: "berlin".to_owned(),
            body_markdown: "# secret plans".to_owned(),
        };
        let summary = archcar_response_summary(&response);
        assert_eq!(summary, "summary_draft workspace=berlin chars=14");
        assert!(!summary.contains("secret"));
    }
}
