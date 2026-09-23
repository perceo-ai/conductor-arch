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
    /// How many inventory snapshots this store has asked the daemon for. The
    /// number is the whole point of the coalescing below, so it is observable
    /// rather than inferred from a log.
    public private(set) var refreshCount = 0

    /// How long the store waits for the event stream to go quiet before
    /// refetching. Long enough to swallow one turn's worth of events, short
    /// enough that the list still reads as live.
    public static let refreshQuietWindow = Duration.milliseconds(250)

    private var isCoalescing = false
    private var refreshAgain = false
    private var coalescedRefresh: Task<Void, Never>?

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

    @discardableResult
    public func archive(_ workspace: WorkspaceSummary, removeWorktree: Bool) async -> Bool {
        await mutate(
            ArchiveWorkspaceRequest(workspace: workspace.name, removeWorktree: removeWorktree),
            failure: "Could not archive \(workspace.name).")
    }

    @discardableResult
    public func restore(_ workspace: WorkspaceSummary) async -> Bool {
        await mutate(
            RestoreWorkspaceRequest(workspace: workspace.name),
            failure: "Could not restore \(workspace.name).")
    }

    @discardableResult
    public func rename(_ workspace: WorkspaceSummary, to name: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != workspace.name else { return false }
        return await mutate(
            RenameWorkspaceRequest(workspace: workspace.name, name: trimmed),
            failure: "Could not rename \(workspace.name).")
    }

    /// Runs a lifecycle request and only refreshes when the daemon confirmed it.
    ///
    /// Refreshing regardless would hide the failure twice over: the row would
    /// come back unchanged with no explanation, and the successful refresh
    /// would clear the error the failed request had just set.
    private func mutate<Body: ArchcarRequestBody>(_ body: Body, failure: String) async -> Bool {
        isMutating = true
        defer { isMutating = false }
        let response = await send(body)
        switch response {
        case .workspaceUpdated, .workspaceRemoved, .workspaceCreated, .ack:
            await refresh()
            return true
        case .none:
            // `send` already recorded why.
            return false
        case .some(let other):
            lastError = "\(failure) The daemon answered \(other)."
            return false
        }
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
        refreshCount += 1
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
            ArchcarLog.store.error(
                "inventory refresh failed error=\(String(describing: error), privacy: .public)")
        }
    }

    /// Runs for the lifetime of the session, refreshing on every event that
    /// touches the list.
    ///
    /// The refetch is coalesced rather than run per event. One agent turn emits
    /// a spawn, a start, a ready, interactions, and a completion, and every one
    /// of them invalidates the list; on a phone each refetch is a fresh TCP
    /// connection plus a whole inventory snapshot over a VPN, so answering each
    /// event separately turns a busy daemon into a permanent backlog.
    public func observe() async {
        for await event in await session.events where Self.invalidates(event) {
            refreshSoon()
        }
        coalescedRefresh?.cancel()
    }

    /// Asks for a refresh without waiting for one. Bursts collapse into a
    /// single round trip; events that land mid-refetch earn exactly one more.
    public func refreshSoon() {
        guard !isCoalescing else {
            refreshAgain = true
            return
        }
        isCoalescing = true
        coalescedRefresh = Task { [weak self] in
            await self?.drainCoalescedRefreshes()
        }
    }

    private func drainCoalescedRefreshes() async {
        defer {
            isCoalescing = false
            coalescedRefresh = nil
        }
        repeat {
            // Let the rest of the burst land before paying for a round trip.
            try? await Task.sleep(for: Self.refreshQuietWindow)
            guard !Task.isCancelled else { return }
            refreshAgain = false
            await refresh()
        } while refreshAgain && !Task.isCancelled
    }
}
