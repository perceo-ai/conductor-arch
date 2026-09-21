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
    public private(set) var scope: WorkspaceChangeScope = .all
    public private(set) var checks: ChecksSummary?
    public private(set) var runs: WorkflowRunSummary?
    public private(set) var todos: [Todo] = []
    public private(set) var readiness: String?
    public private(set) var lastError: String?
    public private(set) var isBusy = false
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

    public func refreshAll() async {
        await refreshChanges()
        await refreshChecks()
        await refreshTodos()
    }

    public func refreshChanges() async {
        guard case .workspaceChanges(_, let files)? = await request(
            GetWorkspaceChangesRequest(workspace: workspace, scope: scope)) else { return }
        self.files = files.sorted { $0.path < $1.path }
    }

    public func refreshChecks() async {
        if case .checksSummary(_, let summary)? = await request(
            GetChecksSummaryRequest(workspace: workspace)) {
            checks = summary
        }
        if case .workflowRuns(_, let summary)? = await request(
            ListWorkflowRunsRequest(workspace: workspace)) {
            runs = summary
        }
    }

    public func refreshTodos() async {
        guard case .todos(_, let todos)? = await request(
            ListTodosRequest(workspace: workspace)) else { return }
        self.todos = todos
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

    public func observe() async {
        for await event in await session.events where Self.invalidates(event, workspace: workspace) {
            await refreshChanges()
            await refreshChecks()
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

    private func request<Body: ArchcarRequestBody>(_ body: Body) async -> ArchcarResponse? {
        do {
            let response = try await session.request(body)
            lastError = nil
            return response
        } catch {
            lastError = String(describing: error)
            return nil
        }
    }
}
