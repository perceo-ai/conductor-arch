import Foundation
import Testing

@testable import ArchcarKit

private func requestType(_ line: String) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          let payload = object["payload"] as? [String: Any] else { return nil }
    return payload["type"] as? String
}

private func replyID(_ line: String) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
    else { return nil }
    return object["id"] as? String
}

/// A mock that answers the chat RPCs a store issues.
private func chatResponder(
    projectionBody: String = "on it",
    queued: [String] = [],
    pendingInteraction: Bool = false,
    spawnIsQueued: Bool = false,
    resolveFails: Bool = false
) -> @Sendable (String) -> String? {
    { line in
        guard let id = replyID(line), let type = requestType(line) else { return nil }
        switch type {
        case "list_chat_threads":
            return """
            {"id":"\(id)","payload":{"type":"chat_threads","workspace":"w","threads":[\
            {"id":7,"provider":"codex","title":"Fix auth","status":"open",\
            "updated_at":"1758326400"}]}}
            """
        case "get_chat_projection":
            return """
            {"id":"\(id)","payload":{"type":"chat_projection","thread_id":7,"items":[\
            {"id":"a","sequence":1,"render_class":"assistant_chat","role_label":"assistant",\
            "title":"","body":"\(projectionBody)","status":"complete","stream_state":"complete"}]}}
            """
        case "list_queued_chat_inputs":
            let inputs = queued.enumerated().map { index, text in
                """
                {"id":\(index + 1),"thread_id":7,"input":"\(text)","kind":"user",\
                "session_kind":"codex","created_at":"1","updated_at":"1"}
                """
            }.joined(separator: ",")
            return #"{"id":"\#(id)","payload":{"type":"queued_chat_inputs","thread_id":7,"inputs":[\#(inputs)]}}"#
        case "list_provider_interactions":
            let interaction = """
            {"id":"i1","provider_key":"claude","workspace":"w","thread_id":7,"session_id":3,\
            "native_id":"n","kind":"permission","title":"Run tests?","detail":"cargo test",\
            "questions":[],"native_request":{},"request_fingerprint":"f","status":"pending",\
            "created_at":"1"}
            """
            return #"{"id":"\#(id)","payload":{"type":"provider_interactions","interactions":[\#(pendingInteraction ? interaction : "")]}}"#
        case "get_session_status":
            return """
            {"id":"\(id)","payload":{"type":"session_status","session_id":3,"status":"running",\
            "runtime_state":"streaming","ready":false,"pending_interactions":0}}
            """
        case "ensure_chat_thread_session":
            return spawnIsQueued
                ? #"{"id":"\#(id)","payload":{"type":"session_spawn_queued","workspace":"w","kind":"codex"}}"#
                : """
                {"id":"\(id)","payload":{"type":"session_spawned","session_id":3,"thread_id":7,\
                "workspace":"w","kind":"codex"}}
                """
        case "queue_chat_input":
            return """
            {"id":"\(id)","payload":{"type":"queued_chat_input","input":\
            {"id":9,"thread_id":7,"input":"ship it","kind":"user","session_kind":"codex",\
            "created_at":"1","updated_at":"1"}}}
            """
        case "resolve_provider_interaction":
            return resolveFails
                ? #"{"id":"\#(id)","payload":{"type":"error","message":"interaction already resolved"}}"#
                : #"{"id":"\#(id)","payload":{"type":"ack"}}"#
        case "get_chat_plan":
            return #"{"id":"\#(id)","payload":{"type":"chat_plan","thread_id":7,"plan_mode":false}}"#
        case "interrupt_turn", "set_chat_plan_mode":
            return #"{"id":"\#(id)","payload":{"type":"ack"}}"#
        default:
            return nil
        }
    }
}

@MainActor
private func connectedStore(
    _ daemon: MockDaemon,
    responder: @escaping @Sendable (String) -> String? = chatResponder()
) async throws -> (DaemonSession, ChatStore) {
    await daemon.respond(to: responder)
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    return (session, ChatStore(session: session, workspace: "w"))
}

@MainActor
@Test func loadsThreadsAndSelectsTheFirst() async throws {
    let daemon = try await MockDaemon()
    let (session, store) = try await connectedStore(daemon)

    await store.refreshThreads()
    #expect(store.threads.map(\.title) == ["Fix auth"])

    await store.select(threadID: 7)
    #expect(store.items.map(\.body) == ["on it"])
    #expect(store.selectedThreadID == 7)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func sendingEnsuresASessionThenQueuesTheTurn() async throws {
    let daemon = try await MockDaemon()
    let (session, store) = try await connectedStore(daemon)
    await store.refreshThreads()
    await store.select(threadID: 7)

    await store.send("ship it")

    let sent = await daemon.receivedLines.compactMap(requestType)
    // A thread with no live session must get one before a turn is queued, or
    // the input sits in the queue with nothing to drain it.
    let ensureIndex = try #require(sent.firstIndex(of: "ensure_chat_thread_session"))
    let queueIndex = try #require(sent.firstIndex(of: "queue_chat_input"))
    #expect(ensureIndex < queueIndex)
    #expect(store.composerError == nil)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func queuedSpawnStillQueuesTheTurn() async throws {
    // The daemon answers `session_spawn_queued` whenever it cannot spawn
    // immediately, which is the normal case for a cold provider. Treating that
    // as a failure silently drops the user's turn.
    let daemon = try await MockDaemon()
    let (session, store) = try await connectedStore(
        daemon, responder: chatResponder(spawnIsQueued: true))
    await store.refreshThreads()
    await store.select(threadID: 7)

    await store.send("ship it")

    let sent = await daemon.receivedLines.compactMap(requestType)
    #expect(sent.contains("queue_chat_input"))
    #expect(store.composerError == nil)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func refusesToSendWhitespace() async throws {
    let daemon = try await MockDaemon()
    let (session, store) = try await connectedStore(daemon)
    await store.refreshThreads()
    await store.select(threadID: 7)
    let before = await daemon.receivedLines.count

    await store.send("   \n ")

    #expect(await daemon.receivedLines.count == before)
    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func loadsPendingInteractions() async throws {
    let daemon = try await MockDaemon()
    let (session, store) = try await connectedStore(
        daemon, responder: chatResponder(pendingInteraction: true))
    await store.refreshThreads()
    await store.select(threadID: 7)

    #expect(store.pendingInteractions.map(\.title) == ["Run tests?"])
    // A blocked agent is the one thing worth interrupting someone for, so the
    // store surfaces it as its own flag rather than burying it in a list.
    #expect(store.isBlocked)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func resolveSurfacesFailureAndLeavesTheInteractionPending() async throws {
    let daemon = try await MockDaemon()
    let (session, store) = try await connectedStore(
        daemon, responder: chatResponder(pendingInteraction: true, resolveFails: true))
    await store.refreshThreads()
    await store.select(threadID: 7)
    #expect(store.isBlocked)

    let interaction = try #require(store.pendingInteractions.first)
    let before = await daemon.receivedLines.count
    let outcome = await store.resolve(interaction, with: .approve)

    guard case .failure(let message) = outcome else {
        Issue.record("expected a failure outcome, got \(outcome)")
        return
    }
    // The daemon's own words, not `daemon("…")`.
    #expect(message == "The daemon said: interaction already resolved")
    // A failed resolve must leave the interaction pending rather than
    // silently clearing it. The mock re-serves the interaction on every read,
    // so `isBlocked` alone can't show that; what proves it is that no
    // refetch was sent after the resolve.
    let lines = await daemon.receivedLines
    let sent = lines.dropFirst(before).compactMap(requestType)
    #expect(sent.contains("resolve_provider_interaction"))
    #expect(!sent.contains("list_provider_interactions"))
    #expect(store.isBlocked)

    await session.disconnect()
    await daemon.stop()
}

@Test func resolveFailuresReadAsSentences() {
    #expect(ChatStore.resolveFailureMessage(for: DaemonSessionError.daemon("interaction already resolved"))
        == "The daemon said: interaction already resolved")
    #expect(ChatStore.resolveFailureMessage(for: DaemonSessionError.disconnected)
        == "Connection to the daemon was lost.")
    #expect(ChatStore.resolveFailureMessage(for: DaemonSessionError.timedOut) == "The request timed out.")
    #expect(ChatStore.resolveFailureMessage(for: DaemonSessionError.authenticationFailed)
        == "Authentication failed.")
    #expect(ChatStore.resolveFailureMessage(for: DaemonSessionError.closedWithoutResponse)
        == "The daemon closed the connection before confirming.")
}

@MainActor
@Test func resolveSurfacesSuccessToTheCaller() async throws {
    let daemon = try await MockDaemon()
    let (session, store) = try await connectedStore(
        daemon, responder: chatResponder(pendingInteraction: true))
    await store.refreshThreads()
    await store.select(threadID: 7)
    let interaction = try #require(store.pendingInteractions.first)

    let outcome = await store.resolve(interaction, with: .approve)
    #expect(outcome == .success)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func queuedTurnsAreReadBackFromTheDaemon() async throws {
    let daemon = try await MockDaemon()
    let (session, store) = try await connectedStore(
        daemon, responder: chatResponder(queued: ["next task"]))
    await store.refreshThreads()
    await store.select(threadID: 7)

    #expect(store.queued.map(\.displayText) == ["next task"])
    await session.disconnect()
    await daemon.stop()
}

@Test func eventRoutingIgnoresOtherThreads() {
    #expect(ChatStore.refreshKind(for: .sessionMessagesUpdated(threadID: 7), thread: 7) == .timeline)
    #expect(ChatStore.refreshKind(for: .sessionMessagesUpdated(threadID: 8), thread: 7) == nil)
    #expect(ChatStore.refreshKind(for: .chatQueueUpdated(threadID: 7), thread: 7) == .queue)
    #expect(
        ChatStore.refreshKind(for: .turnCompleted(sessionID: 1, threadID: 7, status: nil), thread: 7)
            == .timeline)
    #expect(
        ChatStore.refreshKind(
            for: .chatPlanUpdated(threadID: 7, planMode: true, planPath: nil), thread: 7) == .plan)
    // A rename changes the thread list, not the conversation.
    #expect(
        ChatStore.refreshKind(for: .chatThreadRenamed(threadID: 7, title: "x"), thread: 7)
            == .threads)
}

@Test func interactionEventsRouteByTheirOwnThread() throws {
    let json = """
    {"id":"e","payload":{"type":"provider_interaction_requested","interaction":\
    {"id":"i1","provider_key":"claude","workspace":"w","thread_id":7,"session_id":3,\
    "native_id":"n","kind":"permission","title":"t","detail":"d","questions":[],\
    "native_request":{},"request_fingerprint":"f","status":"pending","created_at":"1"}}}
    """
    let event = try JSONDecoder().decode(EventEnvelope.self, from: Data(json.utf8)).payload
    #expect(ChatStore.refreshKind(for: event, thread: 7) == .interactions)
    #expect(ChatStore.refreshKind(for: event, thread: 9) == nil)
}

@MainActor
@Test func adoptsASessionThatWasRunningBeforeTheChatOpened() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: chatResponder())
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    await daemon.waitForSubscribes(1)

    // The daemon's subscribe-time replay of a running agent. Only the session
    // is listening yet: no chat store exists to catch it.
    await daemon.push(
        #"{"id":"e1","payload":{"type":"session_started","session_id":3,"thread_id":7,"workspace":"w","kind":"codex","pid":900}}"#)
    await daemon.push(#"{"id":"e2","payload":{"type":"session_ready","session_id":3,"thread_id":7}}"#)
    #expect(await eventually { await session.cachedSessionID(forThread: 7) == 3 })

    let store = ChatStore(session: session, workspace: "w")
    await store.refreshThreads()
    await store.select(threadID: 7)

    // Model and Effort are enabled, and the composer shows Stop: the mock
    // reports the session as streaming.
    #expect(store.hasLiveSession)
    #expect(store.isTurnRunning)

    // And Stop reaches that session.
    let before = await daemon.receivedLines.count
    await store.interrupt()
    let lines = await daemon.receivedLines
    let interrupt = try #require(lines.dropFirst(before).first { requestType($0) == "interrupt_turn" })
    let decoded = try JSONSerialization.jsonObject(with: Data(interrupt.utf8))
    let payload = try #require((decoded as? [String: Any])?["payload"] as? [String: Any])
    #expect((payload["session_id"] as? NSNumber)?.int64Value == 3)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func aDroppedStreamMarksTheChatStaleAndRefetchesOnReconnect() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: chatResponder())
    // Too slow to reconnect on its own within the test, so the stale state
    // holds until `reconnectNow` ends it.
    let session = DaemonSession(
        address: await daemon.address, token: "t",
        backoff: Backoff(base: .seconds(30), cap: .seconds(30)))
    try await session.connect()
    let store = ChatStore(session: session, workspace: "w")
    await store.refreshThreads()
    await store.select(threadID: 7)
    #expect(store.isStale == false)

    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))
    let before = await daemon.receivedLines.count

    await daemon.endEventConnection()

    // Stale straight away, and not because a request failed: none was sent.
    #expect(await eventually { @MainActor in store.isStale })
    #expect(await daemon.receivedLines.count == before)

    await session.reconnectNow()

    // Everything on screen is refetched once the stream is back.
    #expect(await eventually {
        await daemon.receivedLines.dropFirst(before).compactMap(requestType).contains("get_chat_projection")
    })
    let sent = await daemon.receivedLines.dropFirst(before).compactMap(requestType)
    #expect(sent.contains("subscribe"))
    #expect(sent.contains("list_chat_threads"))
    #expect(sent.contains("list_queued_chat_inputs"))
    #expect(sent.contains("list_provider_interactions"))
    #expect(await eventually { @MainActor in !store.isStale })

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}
