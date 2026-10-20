import Foundation

/// The review surface for one workspace: what changed, whether it passes, and
/// where its pull request stands.
///
/// Like every other store here, it owns no truth — each refresh is a request,
/// and events only say what to refetch.
@MainActor
@Observable
public final class ReviewStore {
    public private(set) var files: [DiffFileSummary] = []
    /// Why the last changes fetch failed, if it did.
    ///
    /// Tracked separately from `lastError` because an empty `files` is
    /// ambiguous: a clean worktree and a daemon that refused to answer look
    /// identical, and telling someone "no changes" about a tree full of them is
    /// worse than telling them nothing.
    public private(set) var changesError: String?
    public private(set) var scope: WorkspaceChangeScope = .all
    public private(set) var checks: ChecksSummary?
    public private(set) var runs: WorkflowRunSummary?
    public private(set) var todos: [Todo] = []
    public private(set) var readiness: String?
    public private(set) var lastError: String?
    public private(set) var isBusy = false
    /// Whether each panel may be showing out-of-date data: the event stream
    /// has dropped, or a fetch failed. Each is cleared only by a refetch of
    /// that panel that succeeded while the stream is connected; see
    /// `StaleClearing`.
    public private(set) var changesStale = false
    public private(set) var checksStale = false
    public private(set) var todosStale = false
    /// Whether any panel is out of date.
    public var isStale: Bool { changesStale || checksStale || todosStale }
    /// Bumped by every `markStale()`, so a clear decided before an `await`
    /// can tell a mark landed since; see `StaleClearing`.
    @ObservationIgnored private(set) var staleRevision = 0
    /// Output from the last git/gh action, worth showing verbatim: when `gh`
    /// refuses, the reason is on the other machine and the text is all the
    /// phone has.
    public private(set) var actionOutput: String?

    private let session: DaemonSession
    public let workspace: String

    public init(session: DaemonSession, workspace: String) {
        self.session = session
        self.workspace = workspace
    }

    public var openTodos: [Todo] { todos.filter(\.isOpen) }

    public func setScope(_ scope: WorkspaceChangeScope) async {
        self.scope = scope
        await refreshChanges()
    }

    /// Refetches every panel, and clears the stale mark only if all of them
    /// came back: a later fetch succeeding says nothing about an earlier one
    /// that failed and left its panel showing old data.
    public func refreshAll() async {
        // A mark landing while any fetch below is in flight must win.
        let revision = staleRevision
        // Each runs regardless of the others, so no `&&` short-circuit.
        let gotChanges = await fetchChanges()
        let gotChecks = await fetchChecks()
        let gotTodos = await fetchTodos()
        await clearStale(
            afterRefetchSucceeded: gotChanges && gotChecks && gotTodos, clearing: .all, unchangedSince: revision)
    }

    public func refreshChanges() async {
        await clearStale(afterRefetchSucceeded: await fetchChanges(), clearing: .changes)
    }

    public func refreshChecks() async {
        await clearStale(afterRefetchSucceeded: await fetchChecks(), clearing: .checks)
    }

    public func refreshTodos() async {
        await clearStale(afterRefetchSucceeded: await fetchTodos(), clearing: .todos)
    }

    // The fetches below report whether they got an answer and leave the
    // stale mark to their caller, which knows how much was refetched.

    private func fetchChanges() async -> Bool {
        guard case .workspaceChanges(_, let files)? = await request(
            GetWorkspaceChangesRequest(workspace: workspace, scope: scope))
        else {
            changesError = lastError ?? "The daemon did not answer."
            ArchcarLog.store.error(
                "workspace changes failed workspace=\(self.workspace, privacy: .public) error=\(self.changesError ?? "", privacy: .public)")
            return false
        }
        changesError = nil
        self.files = files.sorted { $0.path < $1.path }
        return true
    }

    private func fetchChecks() async -> Bool {
        var fetched = true
        if case .checksSummary(_, let summary)? = await request(
            GetChecksSummaryRequest(workspace: workspace)) {
            checks = summary
        } else {
            fetched = false
        }
        if case .workflowRuns(_, let summary)? = await request(
            ListWorkflowRunsRequest(workspace: workspace)) {
            runs = summary
        } else {
            fetched = false
        }
        return fetched
    }

    private func fetchTodos() async -> Bool {
        guard case .todos(_, let todos)? = await request(
            ListTodosRequest(workspace: workspace)) else { return false }
        self.todos = todos
        return true
    }

    /// The panels a refetch covered, and so the only ones it may clear.
    private struct StalePanels: OptionSet {
        let rawValue: Int
        static let changes = StalePanels(rawValue: 1 << 0)
        static let checks = StalePanels(rawValue: 1 << 1)
        static let todos = StalePanels(rawValue: 1 << 2)
        static let all: StalePanels = [.changes, .checks, .todos]
    }

    /// A batch passes the revision it read before its first fetch.
    private func clearStale(
        afterRefetchSucceeded succeeded: Bool, clearing panels: StalePanels, unchangedSince: Int? = nil
    ) async {
        guard await StaleClearing.mayClear(
            afterRefetchSucceeded: succeeded, on: session, store: self, unchangedSince: unchangedSince)
        else { return }
        if panels.contains(.changes) { changesStale = false }
        if panels.contains(.checks) { checksStale = false }
        if panels.contains(.todos) { todosStale = false }
    }

    public func addTodo(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        _ = await request(AddTodoRequest(workspace: workspace, text: trimmed))
        await refreshTodos()
    }

    public func diff(for path: String?) async -> String? {
        guard case .workspaceDiff(_, let text)? = await request(
            GetWorkspaceDiffRequest(workspace: workspace, path: path, scope: scope)) else {
            return nil
        }
        return text
    }

    public func refreshReadiness() async {
        guard case .pullRequestReadiness(_, let text)? = await request(
            GetPullRequestReadinessRequest(workspace: workspace)) else { return }
        readiness = text
    }

    /// The daemon drafts a title and body from the workspace's own evidence —
    /// nobody wants to write a PR description on a phone.
    public func pullRequestDraft() async -> (title: String, body: String)? {
        guard case .pullRequestDraft(let title, let body)? = await request(
            GetPullRequestDraftRequest(workspace: workspace)) else { return nil }
        return (title, body)
    }

    public func push(force: Bool = false) async {
        await runAction(PushBranchRequest(workspace: workspace, force: force))
    }

    public func createPullRequest(title: String?, body: String?, draft: Bool) async {
        await runAction(
            CreatePullRequestRequest(workspace: workspace, title: title, body: body, draft: draft))
    }

    public func mergePullRequest(method: String?) async {
        await runAction(MergePullRequestRequest(workspace: workspace, method: method))
    }

    public func commit(message: String) async {
        await runAction(CommitWorkspaceChangesRequest(workspace: workspace, message: message))
        await refreshChanges()
    }

    /// Which events mean this panel is out of date. Chat churn is excluded on
    /// purpose: an agent writing a file emits a stream of them, and refetching
    /// a diff per token would spend the whole link on it.
    public nonisolated static func invalidates(_ event: ArchcarEvent, workspace: String) -> Bool {
        switch event {
        case .turnCompleted, .sessionExited:
            return true
        case .inventoryChanged(_, let changed, _):
            return changed == nil || changed == workspace
        case .taskUpdated(let changed, _, _), .summaryUpdated(let changed, _, _, _):
            return changed == workspace
        default:
            return false
        }
    }

    /// Keeps the panels live. A dropped stream is waited out and, once the
    /// session has reconnected, everything is refetched before listening
    /// again, since whatever changed in between was missed.
    public func observe() async {
        var missedEvents = false
        while !Task.isCancelled {
            if await session.connectionState != .connected { markStale() }
            guard let subscription = await session.connectedEvents() else { return }
            if missedEvents || subscription.waited { await refreshAll() }
            for await event in subscription.events where Self.invalidates(event, workspace: workspace) {
                let revision = staleRevision
                let gotChanges = await fetchChanges()
                let gotChecks = await fetchChecks()
                // Todos are not refetched here, so their mark stays.
                await clearStale(
                    afterRefetchSucceeded: gotChanges && gotChecks, clearing: [.changes, .checks],
                    unchangedSince: revision)
            }
            guard !Task.isCancelled else { return }
            markStale()
            missedEvents = true
        }
    }

    private func runAction<Body: ArchcarRequestBody>(_ body: Body) async {
        isBusy = true
        defer { isBusy = false }
        switch await request(body) {
        case .pullRequestCreated(_, let output):
            actionOutput = output
        case .ack:
            actionOutput = "Done."
        case .some(let other):
            actionOutput = String(describing: other)
        case .none:
            break
        }
        await refreshChecks()
    }

    /// Marks the store stale on failure, but never clears it: a one-shot
    /// request succeeding is not a refetch of the panels. Clearing is the
    /// `refresh…` methods' job.
    private func request<Body: ArchcarRequestBody>(_ body: Body) async -> ArchcarResponse? {
        do {
            let response = try await session.request(body)
            lastError = nil
            return response
        } catch {
            markStale()
            lastError = String(describing: error)
            return nil
        }
    }

    /// Marks every panel: a failed request does not say which panel it was
    /// for, and a dropped stream leaves them all missing updates.
    private func markStale() {
        changesStale = true
        checksStale = true
        todosStale = true
        staleRevision += 1
    }
}

extension ReviewStore: StaleRevisioned {}
