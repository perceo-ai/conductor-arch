import Foundation

/// The workspace list, kept live off the daemon's event stream.
///
/// Events carry identifiers, not state, so this refetches the inventory rather
/// than patching rows — the same contract the desktop follows, which is what
/// keeps the two surfaces from disagreeing about what is stale.
@MainActor
@Observable
public final class WorkspacesStore {
    public private(set) var workspaces: [WorkspaceSummary] = []
    public private(set) var repositories: [RepositorySummary] = []
    /// Chats per workspace, straight off the inventory snapshot, so the Chats
    /// tab costs no extra round trips.
    public private(set) var chatThreads: [String: [ChatThread]] = [:]
    /// True when the last refresh failed. The rows stay on screen — last-known
    /// state beats a spinner — but the UI marks them and disables mutations.
    public private(set) var isStale = false
    public private(set) var lastError: String?
    /// A create/archive/restore is in flight; the UI disables its controls so
    /// a slow worktree operation cannot be fired twice.
    public private(set) var isMutating = false

    private let session: DaemonSession

    public init(session: DaemonSession) {
        self.session = session
    }

    /// Which events mean the workspace list may have changed. Chat-level churn
    /// is excluded: refetching the whole inventory on every streamed message
    /// would put a full round-trip behind each token of an agent's reply.
    public nonisolated static func invalidates(_ event: ArchcarEvent) -> Bool {
        switch event {
        case .inventoryChanged, .workspaceRenamed, .taskUpdated, .summaryUpdated,
             .sessionSpawnQueued, .sessionStarted, .sessionReady, .sessionExited,
             .sessionError, .turnCompleted, .backgroundTaskUpdated,
             .providerInteractionRequested, .providerInteractionResolved:
            return true
        case .sessionScreenUpdated, .sessionMessagesUpdated, .chatQueueUpdated,
             .chatPlanUpdated, .chatThreadRenamed, .sessionCapabilitiesChanged,
             .unknown:
            return false
        }
    }

    /// Workspaces grouped by repository, which is how a phone reads them: the
    /// repository is the heading, the workspaces are the rows.
    public struct RepositoryGroup: Identifiable, Sendable {
        public let repository: RepositorySummary
        public let workspaces: [WorkspaceSummary]
        public var id: Int64 { repository.id }
    }

    public var groups: [RepositoryGroup] {
        repositories
            .sorted { $0.name < $1.name }
            .map { repository in
                RepositoryGroup(
                    repository: repository,
                    workspaces: workspaces.filter { $0.repositoryName == repository.name })
            }
    }

    /// Workspaces whose repository is gone from the inventory. They would
    /// otherwise vanish from a grouped list without explanation.
    public var orphanedWorkspaces: [WorkspaceSummary] {
        let known = Set(repositories.map(\.name))
        return workspaces.filter { !known.contains($0.repositoryName) }
    }

    // --- Lifecycle ---------------------------------------------------------

    public enum CreateRequest: Sendable, Equatable {
        case branch(name: String, branch: String, baseRef: String?)
        case prompt(String)
        case issue(number: Int)
        case pullRequest(number: Int)
        case linear(id: String)
    }

    /// Creates a workspace and returns its name, which the daemon assigns for
    /// the prompt and issue forms.
    @discardableResult
    public func createWorkspace(in repository: String, _ request: CreateRequest) async -> String? {
        isMutating = true
        defer { isMutating = false }
        let response: ArchcarResponse?
        switch request {
        case .branch(let name, let branch, let baseRef):
            response = await send(
                CreateWorkspaceRequest(
                    repository: repository, name: name, branch: branch, baseRef: baseRef))
        case .prompt(let prompt):
            response = await send(
                CreateWorkspaceFromPromptRequest(repository: repository, prompt: prompt))
        case .issue(let number):
            response = await send(
                CreateWorkspaceFromIssueRequest(repository: repository, issueNumber: number))
        case .pullRequest(let number):
            response = await send(
                CreateWorkspaceFromPullRequestRequest(repository: repository, prNumber: number))
        case .linear(let id):
            response = await send(
                CreateWorkspaceFromLinearRequest(repository: repository, issueID: id))
        }
        guard case .workspaceCreated(let name)? = response else { return nil }
        await refresh()
        return name
    }

    public func archive(_ workspace: WorkspaceSummary, removeWorktree: Bool) async {
        isMutating = true
        defer { isMutating = false }
        _ = await send(
            ArchiveWorkspaceRequest(workspace: workspace.name, removeWorktree: removeWorktree))
        await refresh()
    }

    public func restore(_ workspace: WorkspaceSummary) async {
        isMutating = true
        defer { isMutating = false }
        _ = await send(RestoreWorkspaceRequest(workspace: workspace.name))
        await refresh()
    }

    public func rename(_ workspace: WorkspaceSummary, to name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != workspace.name else { return }
        _ = await send(RenameWorkspaceRequest(workspace: workspace.name, name: trimmed))
        await refresh()
    }

    public func addRepository(path: String, name: String?) async -> Bool {
        isMutating = true
        defer { isMutating = false }
        guard case .repositoryAdded? = await send(
            AddRepositoryRequest(path: path, name: name)) else { return false }
        await refresh()
        return true
    }

    public func cloneRepository(url: String, dest: String, name: String?) async -> Bool {
        isMutating = true
        defer { isMutating = false }
        guard case .repositoryAdded? = await send(
            CloneRepositoryRequest(url: url, dest: dest, name: name)) else { return false }
        await refresh()
        return true
    }

    private func send<Body: ArchcarRequestBody>(_ body: Body) async -> ArchcarResponse? {
        do {
            let response = try await session.request(body)
            lastError = nil
            return response
        } catch {
            lastError = String(describing: error)
            return nil
        }
    }

    public func refresh() async {
        do {
            let response = try await session.request(GetInventorySnapshotRequest())
            guard case .inventorySnapshot(let repositories, let workspaces, let chatThreads) = response
            else {
                lastError = "unexpected response: \(response)"
                isStale = true
                return
            }
            self.repositories = repositories
            self.workspaces = workspaces.sorted { $0.updatedAt > $1.updatedAt }
            self.chatThreads = chatThreads
            isStale = false
            lastError = nil
        } catch {
            lastError = String(describing: error)
            isStale = true
        }
    }

    /// Runs for the lifetime of the session, refreshing on every event that
    /// touches the list.
    public func observe() async {
        for await event in await session.events where Self.invalidates(event) {
            await refresh()
        }
    }
}
