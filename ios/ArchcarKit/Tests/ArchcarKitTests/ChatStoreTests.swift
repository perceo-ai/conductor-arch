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
    pendingInteraction: Bool = false
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
            "title":"","body":"\(projectionBody)","status":"complete","stream_state":"final"}]}}
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
            return """
            {"id":"\(id)","payload":{"type":"session_spawned","session_id":3,"thread_id":7,\
            "workspace":"w","kind":"codex"}}
            """
        case "queue_chat_input":
            return """
            {"id":"\(id)","payload":{"type":"queued_chat_input","input":\
            {"id":9,"thread_id":7,"input":"ship it","kind":"user","session_kind":"codex",\
            "created_at":"1","updated_at":"1"}}}
            """
        case "resolve_provider_interaction", "interrupt_turn", "set_chat_plan_mode":
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
