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
    // One mark per panel, so a refetch lifts only what it brought up to
    // date: a thread-list refresh says nothing about a timeline that failed.
    private var threadsStale = false
    private var timelineStale = false
    private var queueStale = false
    private var planStale = false
    private var interactionsStale = false
    private var statusStale = false
    /// Whether any panel is out of date.
    public var isStale: Bool {
        threadsStale || timelineStale || queueStale || planStale || interactionsStale || statusStale
    }
    /// Bumped by every `markStale()`, so a clear decided before an `await`
    /// can tell a mark landed since; see `StaleClearing`.
    @ObservationIgnored private(set) var staleRevision = 0
    public private(set) var composerError: String?
    public private(set) var isSending = false

    private let session: DaemonSession
    public let workspace: String
    /// The live session behind the selected thread, learned from
    /// `ensure_chat_thread_session`, a session event, or what the session
    /// already knew when the chat was opened.
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
        await clearStale(afterRefetchSucceeded: await fetchThreads(), clearing: .threads)
    }

    private func fetchThreads() async -> Bool {
        guard case .chatThreads(_, let threads)? = await request(
            ListChatThreadsRequest(workspace: workspace)) else { return false }
        // Open chats first, newest first: an archived chat is history, and on a
        // phone the list is short enough that burying it is the whole design.
        self.threads = threads
            .filter { !$0.isArchived }
            .sorted { $0.updatedAt > $1.updatedAt }
        return true
    }

    /// Refetches every panel on screen and clears the stale mark only if all
    /// of them came back: what a pull-to-refresh asks for, any time, rather
    /// than only after a reconnect as `resync()` does.
    public func refreshAll() async {
        // A mark landing while any fetch below is in flight must win.
        let revision = staleRevision
        // Each runs regardless of the others, so no `&&` short-circuit.
        let gotThreads = await fetchThreads()
        let gotStatus = await fetchStatus()
        let gotPlan = await fetchPlan()
        let gotQueue = await fetchQueue()
        let gotInteractions = await fetchInteractions()
        let gotTimeline = await fetchTimeline()
        await clearStale(
            afterRefetchSucceeded: gotThreads && gotStatus && gotPlan && gotQueue && gotInteractions && gotTimeline,
            clearing: .all, unchangedSince: revision)
    }

    public func select(threadID: Int64) async {
        selectedThreadID = threadID
        items = []
        queued = []
        pendingInteractions = []
        sessionStatus = nil
        // An agent started before this store existed announced itself on the
        // event stream before anything here was listening. The session kept
        // that, so a chat opened mid-turn still gets Stop, Model and Effort.
        let known = await session.cachedSessionID(forThread: threadID)
        guard selectedThreadID == threadID else { return }
        sessionID = known
        // The transcript first, so a slow plan or status cannot hold it back.
        await refreshTimeline()
        // Plan and status too, even with no session or plan traffic: a failed
        // request marks every panel, and these need a way back besides a
        // reconnect.
        await refreshStatus()
        await refreshPlan()
        await refreshQueue()
        await refreshInteractions()
    }

    public func refreshTimeline() async {
        await clearStale(afterRefetchSucceeded: await fetchTimeline(), clearing: .timeline)
    }

    public func refreshQueue() async {
        // With no thread there is no queue to check, and skipping it must not
        // clear anything: `removeQueued` and `moveQueued` route here.
        guard selectedThreadID != nil else { return }
        await clearStale(afterRefetchSucceeded: await fetchQueue(), clearing: .queue)
    }

    public func refreshInteractions() async {
        await clearStale(afterRefetchSucceeded: await fetchInteractions(), clearing: .interactions)
    }

    public func refreshPlan() async {
        await clearStale(afterRefetchSucceeded: await fetchPlan(), clearing: .plan)
    }

    public func refreshStatus() async {
        // With no session the status panel is empty, and that is current: it
        // clears only the status mark, so a session exiting cannot lift a
        // mark another panel's failed refetch left.
        await clearStale(afterRefetchSucceeded: await fetchStatus(), clearing: .status)
    }

    // Each fetch reports whether it brought its panel up to date. Nothing to
    // fetch — no thread selected, no session yet — counts as up to date, which
    // is what `resync()` needs: a skipped panel must not fail the whole
    // resync, and it may clear only because every other fetch it ran also
    // succeeded. `refreshQueue()` still returns before clearing with no
    // thread: `removeQueued` and `moveQueued` route there, and they refetched
    // nothing.

    private func fetchTimeline() async -> Bool {
        guard let threadID = selectedThreadID else { return true }
        guard case .chatProjection(_, let items)? = await request(
            GetChatProjectionRequest(threadID: threadID)) else { return false }
        // The same allowlist the desktop applies: only known text and activity
        // classes render, and assistant prose only once it is finalized.
        self.items = items
            .filter(ChatFormat.isDisplayable)
            .sorted { $0.sequence < $1.sequence }
        return true
    }

    private func fetchQueue() async -> Bool {
        guard let threadID = selectedThreadID else { return true }
        guard case .queuedChatInputs(_, let inputs)? = await request(
            ListQueuedChatInputsRequest(threadID: threadID)) else { return false }
        queued = inputs
        return true
    }

    private func fetchInteractions() async -> Bool {
        guard let threadID = selectedThreadID else { return true }
        guard case .providerInteractions(let interactions)? = await request(
            ListProviderInteractionsRequest(threadID: threadID, pendingOnly: true)) else { return false }
        pendingInteractions = interactions.filter(\.isPending)
        return true
    }

    private func fetchPlan() async -> Bool {
        guard let threadID = selectedThreadID else { return true }
        guard case .chatPlan(_, let planMode, _, let markdown)? = await request(
            GetChatPlanRequest(threadID: threadID)) else { return false }
        self.planMode = planMode
        planMarkdown = markdown
        return true
    }

    private func fetchStatus() async -> Bool {
        guard let sessionID else { return true }
        guard case .sessionStatus(let status)? = await request(
            GetSessionStatusRequest(sessionID: sessionID)) else { return false }
        sessionStatus = status
        return true
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

    /// Switches the model on the live session. Both providers accept it
    /// mid-session, so this takes effect on the turn after it.
    public func setModel(_ model: String) async {
        guard let sessionID else {
            composerError = "Start the chat before switching model."
            return
        }
        _ = await request(SetSessionModelRequest(sessionID: sessionID, model: model))
        await refreshThreads()
    }

    public func setEffort(_ effort: String) async {
        guard let sessionID else {
            composerError = "Start the chat before switching effort."
            return
        }
        _ = await request(SetSessionEffortRequest(sessionID: sessionID, effort: effort))
        await refreshThreads()
    }

    /// True once a session is backing this chat, which is what the model and
    /// effort controls need.
    public var hasLiveSession: Bool { sessionID != nil }

    public func setPlanMode(_ enabled: Bool) async {
        guard let threadID = selectedThreadID else { return }
        _ = await request(SetChatPlanModeRequest(threadID: threadID, planMode: enabled))
        planMode = enabled
    }

    /// Whether the daemon took an answer to a blocked agent.
    public enum ResolveOutcome: Sendable, Equatable {
        case success
        case failure(String)
    }

    /// A sentence for a failed resolve, shown on the phone instead of a Swift
    /// enum dump. None of these claim the answer was or was not applied: the
    /// daemon applies it before replying, so a dropped link can lose the reply
    /// to an answer that already went through.
    nonisolated static func resolveFailureMessage(for error: any Error) -> String {
        switch error as? DaemonSessionError {
        case .daemon(let message)?: "The daemon said: \(message)"
        case .authenticationFailed?: "Authentication failed."
        case .disconnected?: "Connection to the daemon was lost."
        case .timedOut?: "The request timed out."
        case .closedWithoutResponse?: "The daemon closed the connection before confirming."
        case nil: "Couldn't reach the daemon."
        }
    }

    /// Answers a blocked agent. This is the reason the app exists on a phone.
    ///
    /// A failure leaves the interaction pending: on a flaky link the caller
    /// has to say so rather than let the user believe the agent is unblocked.
    @discardableResult
    public func resolve(
        _ interaction: ProviderInteraction, with resolution: InteractionResolution
    ) async -> ResolveOutcome {
        // Not the shared `request` helper: it keeps only `String(describing:)`
        // of the error, and the sheet needs a readable sentence.
        do {
            _ = try await session.request(
                ResolveProviderInteractionRequest(interactionID: interaction.id, resolution: resolution))
        } catch {
            markStale()
            let message = Self.resolveFailureMessage(for: error)
            composerError = message
            return .failure(message)
        }
        composerError = nil
        await refreshInteractions()
        return .success
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
    ///
    /// While the stream is down — dropped, or not up yet when the chat opened
    /// — the chat is marked stale, without waiting for a request to fail.
    /// Once the session has reconnected this resubscribes and refetches
    /// everything on screen, because whatever happened in between was missed.
    public func observe() async {
        var missedEvents = false
        while !Task.isCancelled {
            if await session.connectionState != .connected { markStale() }
            // Subscribe before refetching, so an event that lands during the
            // refetch is not lost between the two.
            guard let subscription = await session.connectedEvents() else { return }
            if missedEvents || subscription.waited { await resync() }
            for await event in subscription.events {
                // A session event also teaches the store which session backs
                // this thread, which is what `interrupt` needs.
                if case .sessionStarted(let sessionID, let threadID, _, _, _) = event,
                   threadID == selectedThreadID {
                    self.sessionID = sessionID
                }
                if case .sessionExited(let sessionID, _) = event, sessionID == self.sessionID {
                    self.sessionID = nil
                    sessionStatus = nil
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
            guard !Task.isCancelled else { return }
            markStale()
            missedEvents = true
        }
    }

    /// Refetches everything on screen after a reconnect, and clears the stale
    /// mark only if every sub-fetch succeeded while the connection is still
    /// up: a later one succeeding says nothing about an earlier one that
    /// failed.
    private func resync() async {
        // A mark landing while any fetch below is in flight must win.
        let revision = staleRevision
        // Each runs regardless of the others, so no `&&` short-circuit.
        let gotThreads = await fetchThreads()
        guard let threadID = selectedThreadID else {
            await clearStale(afterRefetchSucceeded: gotThreads, clearing: .threads, unchangedSince: revision)
            return
        }
        // The reconnect's replay may have named a session this store has not
        // seen, for instance one started while the link was down.
        let known = await session.cachedSessionID(forThread: threadID)
        guard selectedThreadID == threadID else { return }
        if let known {
            sessionID = known
        } else if let current = sessionID {
            // The replay has not named it — it may not have landed yet, or
            // the session exited while the link was down and its
            // `session_exited` was missed. Ask, rather than keep Stop, Model
            // and Effort pointed at a session that is gone.
            await reconcileSession(current)
        }
        let gotStatus = await fetchStatus()
        let gotPlan = await fetchPlan()
        let gotQueue = await fetchQueue()
        let gotInteractions = await fetchInteractions()
        let gotTimeline = await fetchTimeline()
        await clearStale(
            afterRefetchSucceeded: gotThreads && gotStatus && gotPlan && gotQueue && gotInteractions && gotTimeline,
            clearing: .all, unchangedSince: revision)
    }

    /// Forgets `sessionID` if the daemon says it is no longer running.
    ///
    /// Only an answer counts: "unknown session" or a non-running status
    /// clears it, while a dropped link keeps it, since that says nothing
    /// about the session.
    private func reconcileSession(_ sessionID: Int64) async {
        let isGone: Bool
        do {
            let response = try await session.request(GetSessionStatusRequest(sessionID: sessionID))
            if case .sessionStatus(let status) = response {
                // The same test the daemon's subscribe replay applies.
                isGone = status.status != "running"
            } else {
                isGone = false
            }
        } catch DaemonSessionError.daemon(_) {
            isGone = true
        } catch {
            isGone = false
        }
        guard isGone, self.sessionID == sessionID else { return }
        self.sessionID = nil
        sessionStatus = nil
    }

    /// Marks the chat stale when a request fails, but never clears the mark:
    /// an action succeeding says nothing about whether what is on screen is
    /// current. Only a refetch clears it, through `clearStale`.
    private func request<Body: ArchcarRequestBody>(_ body: Body) async -> ArchcarResponse? {
        do {
            return try await session.request(body)
        } catch {
            markStale()
            composerError = String(describing: error)
            return nil
        }
    }

    private struct StalePanels: OptionSet {
        let rawValue: Int
        static let threads = StalePanels(rawValue: 1 << 0)
        static let timeline = StalePanels(rawValue: 1 << 1)
        static let queue = StalePanels(rawValue: 1 << 2)
        static let plan = StalePanels(rawValue: 1 << 3)
        static let interactions = StalePanels(rawValue: 1 << 4)
        static let status = StalePanels(rawValue: 1 << 5)
        static let all: StalePanels = [.threads, .timeline, .queue, .plan, .interactions, .status]
    }

    /// Lifts the marks on `panels` only, the ones the refetch covered. A
    /// batch passes the revision it read before its first fetch.
    private func clearStale(
        afterRefetchSucceeded succeeded: Bool, clearing panels: StalePanels, unchangedSince: Int? = nil
    ) async {
        guard await StaleClearing.mayClear(
            afterRefetchSucceeded: succeeded, on: session, store: self, unchangedSince: unchangedSince)
        else { return }
        if panels.contains(.threads) { threadsStale = false }
        if panels.contains(.timeline) { timelineStale = false }
        if panels.contains(.queue) { queueStale = false }
        if panels.contains(.plan) { planStale = false }
        if panels.contains(.interactions) { interactionsStale = false }
        if panels.contains(.status) { statusStale = false }
    }

    /// A failed request or a dropped stream says nothing about which panel
    /// missed what, so every panel is marked.
    private func markStale() {
        threadsStale = true
        timelineStale = true
        queueStale = true
        planStale = true
        interactionsStale = true
        statusStale = true
        staleRevision += 1
    }
}

extension ChatStore: StaleRevisioned {}
