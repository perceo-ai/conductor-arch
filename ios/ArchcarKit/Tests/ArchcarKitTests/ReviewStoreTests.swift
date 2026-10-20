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

/// A mock that answers the four RPCs `ReviewStore.refreshAll()` issues.
private func reviewResponder() -> @Sendable (String) -> String? {
    { line in
        guard let id = replyID(line), let type = requestType(line) else { return nil }
        switch type {
        case "get_workspace_changes":
            return #"{"id":"\#(id)","payload":{"type":"workspace_changes","workspace":"w","files":[]}}"#
        case "get_checks_summary":
            return """
            {"id":"\(id)","payload":{"type":"checks_summary","workspace":"w","summary":\
            {"workspace":"w","changed_files":0,"active_sessions":0,"open_todos":0,"total_todos":0,\
            "open_review_comments":0}}}
            """
        case "list_workflow_runs":
            return """
            {"id":"\(id)","payload":{"type":"workflow_runs","workspace":"w","summary":\
            {"runs":[],"failing":0,"running":0,"succeeded":0,"unavailable":null}}}
            """
        case "list_todos":
            return #"{"id":"\#(id)","payload":{"type":"todos","workspace":"w","todos":[]}}"#
        default:
            return nil
        }
    }
}

@MainActor
@Test func aDroppedStreamMarksReviewStaleAndRefetchesOnReconnect() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: reviewResponder())
    // Too slow to reconnect on its own within the test, so the stale state
    // holds until `reconnectNow` ends it.
    let session = DaemonSession(
        address: await daemon.address, token: "t",
        backoff: Backoff(base: .seconds(30), cap: .seconds(30)))
    try await session.connect()
    let store = ReviewStore(session: session, workspace: "w")
    await store.refreshAll()
    #expect(store.checks != nil)
    #expect(store.runs != nil)
    #expect(store.isStale == false)

    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))
    let before = await daemon.receivedLines.count

    await daemon.endEventConnection()

    // Stale straight away, and not because a request failed: none was sent.
    #expect(await eventually { @MainActor in store.isStale })
    #expect(await daemon.receivedLines.count == before)

    await session.reconnectNow()

    // The panels are refetched once the stream is back, which clears the mark.
    #expect(await eventually {
        await daemon.receivedLines.dropFirst(before).compactMap(requestType).contains("get_workspace_changes")
    })
    #expect(await eventually { @MainActor in !store.isStale })

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}
