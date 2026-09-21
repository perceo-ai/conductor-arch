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
