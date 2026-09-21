import Foundation

/// One workspace's chats, kept live off the daemon's event stream.
///
/// The daemon owns everything: the projection, the queue, the plan, and the
/// pending asks. This holds no conversation state of its own — an event says
/// what changed, and the matching projection is refetched. That is what lets a
/// phone and a desktop watch the same chat without disagreeing about it.
@MainActor
@Observable
public final class ChatStore {
    /// What a single event invalidates.
    public enum RefreshKind: Sendable, Equatable {
        case threads
        case timeline
        case queue
        case plan
        case interactions
        case status
    }

    public private(set) var threads: [ChatThread] = []
    public private(set) var selectedThreadID: Int64?
    public private(set) var items: [ProjectionItem] = []
    public private(set) var queued: [QueuedChatInput] = []
    public private(set) var pendingInteractions: [ProviderInteraction] = []
    public private(set) var planMode = false
    public private(set) var planMarkdown: String?
    public private(set) var sessionStatus: SessionStatus?
    public private(set) var isStale = false
    public private(set) var composerError: String?
    public private(set) var isSending = false

    private let session: DaemonSession
    public let workspace: String
    /// The live session behind the selected thread, learned from
    /// `ensure_chat_thread_session` or a session event.
    private var sessionID: Int64?

    public init(session: DaemonSession, workspace: String) {
        self.session = session
        self.workspace = workspace
    }

    public var selectedThread: ChatThread? {
        threads.first { $0.id == selectedThreadID }
    }

    /// An agent has stopped and is waiting on a human.
    public var isBlocked: Bool { !pendingInteractions.isEmpty }

    /// Whether a turn is in flight, which decides between a send button and a
    /// stop button.
    public var isTurnRunning: Bool { sessionStatus?.runtimeState.isBusy ?? false }

    // --- Loading -----------------------------------------------------------

    public func refreshThreads() async {
        guard case .chatThreads(_, let threads)? = await request(
            ListChatThreadsRequest(workspace: workspace)) else { return }
        // Open chats first, newest first: an archived chat is history, and on a
        // phone the list is short enough that burying it is the whole design.
        self.threads = threads
            .filter { !$0.isArchived }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    public func select(threadID: Int64) async {
        selectedThreadID = threadID
        items = []
        queued = []
        pendingInteractions = []
        sessionID = nil
        await refreshTimeline()
        await refreshQueue()
        await refreshInteractions()
    }

    public func refreshTimeline() async {
        guard let threadID = selectedThreadID else { return }
        guard case .chatProjection(_, let items)? = await request(
            GetChatProjectionRequest(threadID: threadID)) else { return }
        // The same allowlist the desktop applies: only known text and activity
        // classes render, and assistant prose only once it is finalized.
        self.items = items
            .filter(ChatFormat.isDisplayable)
            .sorted { $0.sequence < $1.sequence }
    }

    public func refreshQueue() async {
        guard let threadID = selectedThreadID else { return }
        guard case .queuedChatInputs(_, let inputs)? = await request(
            ListQueuedChatInputsRequest(threadID: threadID)) else { return }
        queued = inputs
    }

    public func refreshInteractions() async {
        guard let threadID = selectedThreadID else { return }
        guard case .providerInteractions(let interactions)? = await request(
            ListProviderInteractionsRequest(threadID: threadID, pendingOnly: true)) else { return }
        pendingInteractions = interactions.filter(\.isPending)
    }

    public func refreshPlan() async {
        guard let threadID = selectedThreadID else { return }
        guard case .chatPlan(_, let planMode, _, let markdown)? = await request(
            GetChatPlanRequest(threadID: threadID)) else { return }
        self.planMode = planMode
        planMarkdown = markdown
    }

    public func refreshStatus() async {
        guard let sessionID else { return }
        guard case .sessionStatus(let status)? = await request(
            GetSessionStatusRequest(sessionID: sessionID)) else { return }
        sessionStatus = status
    }

    // --- Acting ------------------------------------------------------------

    /// Queues a turn, starting the thread's session first when it has none.
    ///
    /// The order matters: an input queued against a thread with no live session
    /// sits there with nothing to drain it.
    public func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let thread = selectedThread else { return }
        isSending = true
        defer { isSending = false }

        if sessionID == nil {
            // The daemon answers either way depending on whether it could spawn
            // immediately: `session_spawned` carries the id, `session_spawn_queued`
            // does not and the id arrives later on the event stream. Treating the
            // queued answer as a failure would drop the turn on the floor, which
            // is exactly what it did before a real agent was pointed at this.
            switch await request(
                EnsureChatThreadSessionRequest(
                    workspace: workspace, threadID: thread.id, kind: thread.sessionKind)) {
            case .sessionSpawned(let sessionID, _, _, _):
                self.sessionID = sessionID
            case .sessionSpawnQueued:
                break
            case .none:
                composerError = composerError ?? "Could not start a \(thread.provider) session."
                return
            case .some(let other):
                composerError = "Unexpected answer starting the session: \(other)"
                return
            }
        }

        guard await request(
            QueueChatInputRequest(
                threadID: thread.id, input: trimmed, sessionKind: thread.sessionKind)) != nil
        else { return }
        composerError = nil
        await refreshQueue()
    }

    public func interrupt() async {
        guard let sessionID else { return }
        _ = await request(InterruptTurnRequest(sessionID: sessionID))
    }

    public func removeQueued(_ input: QueuedChatInput) async {
        _ = await request(RemoveQueuedChatInputRequest(queueID: input.id))
        await refreshQueue()
    }

    public func moveQueued(_ input: QueuedChatInput, up: Bool) async {
        _ = await request(MoveQueuedChatInputRequest(queueID: input.id, up: up))
        await refreshQueue()
    }

    public func setPlanMode(_ enabled: Bool) async {
        guard let threadID = selectedThreadID else { return }
        _ = await request(SetChatPlanModeRequest(threadID: threadID, planMode: enabled))
        planMode = enabled
    }

    /// Answers a blocked agent. This is the reason the app exists on a phone.
    public func resolve(_ interaction: ProviderInteraction, with resolution: InteractionResolution) async {
        _ = await request(
            ResolveProviderInteractionRequest(interactionID: interaction.id, resolution: resolution))
        await refreshInteractions()
    }

    public func createThread(provider: String, title: String) async -> ChatThread? {
        guard case .chatThreadCreated(let thread)? = await request(
            CreateChatThreadRequest(workspace: workspace, provider: provider, title: title))
        else { return nil }
        await refreshThreads()
        await select(threadID: thread.id)
        return thread
    }

    // --- Events ------------------------------------------------------------

    /// What an event invalidates for the thread on screen. Events for other
    /// threads are dropped: on a phone only one conversation is visible, and
    /// refetching the rest would spend the link on nothing.
    public nonisolated static func refreshKind(for event: ArchcarEvent, thread: Int64?) -> RefreshKind? {
        switch event {
        case .sessionMessagesUpdated(let threadID):
            return threadID == thread ? .timeline : nil
        case .turnCompleted(_, let threadID, _):
            return threadID == thread ? .timeline : nil
        case .chatQueueUpdated(let threadID):
            return threadID == thread ? .queue : nil
        case .chatPlanUpdated(let threadID, _, _):
            return threadID == thread ? .plan : nil
        case .providerInteractionRequested(let interaction),
             .providerInteractionResolved(let interaction):
            return interaction.threadID == thread ? .interactions : nil
        case .sessionReady(_, let threadID), .sessionCapabilitiesChanged(_, let threadID, _):
            return threadID == thread ? .status : nil
        case .sessionStarted(_, let threadID, _, _, _):
            return threadID == thread ? .status : nil
        case .sessionExited, .sessionError:
            return .status
        case .chatThreadRenamed, .inventoryChanged:
            return .threads
        case .sessionSpawnQueued, .sessionScreenUpdated, .summaryUpdated, .taskUpdated,
             .workspaceRenamed, .backgroundTaskUpdated, .unknown:
            return nil
        }
    }

    /// Runs for as long as the chat is on screen.
    public func observe() async {
        for await event in await session.events {
            // A session event also teaches the store which session backs this
            // thread, which is what `interrupt` needs.
            if case .sessionStarted(let sessionID, let threadID, _, _, _) = event,
               threadID == selectedThreadID {
                self.sessionID = sessionID
            }
            guard let kind = Self.refreshKind(for: event, thread: selectedThreadID) else { continue }
            switch kind {
            case .threads: await refreshThreads()
            case .timeline: await refreshTimeline()
            case .queue: await refreshQueue()
            case .plan: await refreshPlan()
            case .interactions: await refreshInteractions()
            case .status: await refreshStatus()
            }
        }
    }

    private func request<Body: ArchcarRequestBody>(_ body: Body) async -> ArchcarResponse? {
        do {
            let response = try await session.request(body)
            isStale = false
            return response
        } catch {
            isStale = true
            composerError = String(describing: error)
            return nil
        }
    }
}
