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

/// A mock that answers the four RPCs `ReviewStore.refreshAll()` issues, plus
/// the todo and push actions. `checksFail`, `changesFail` and `todosFail` make
/// the daemon refuse that panel's fetch, so one leg of a refresh fails while
/// the others succeed.
private func reviewResponder(
    checksFail: Bool = false, changesFail: Bool = false, todosFail: Bool = false
) -> @Sendable (String) -> String? {
    { line in
        guard let id = replyID(line), let type = requestType(line) else { return nil }
        switch type {
        case "get_workspace_changes" where changesFail:
            return #"{"id":"\#(id)","payload":{"type":"error","message":"git status failed"}}"#
        case "get_workspace_changes":
            return #"{"id":"\#(id)","payload":{"type":"workspace_changes","workspace":"w","files":[]}}"#
        case "get_checks_summary" where checksFail:
            return #"{"id":"\#(id)","payload":{"type":"error","message":"gh is not authenticated"}}"#
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
        case "list_todos" where todosFail:
            return #"{"id":"\#(id)","payload":{"type":"error","message":"todo store unavailable"}}"#
        case "list_todos":
            return #"{"id":"\#(id)","payload":{"type":"todos","workspace":"w","todos":[]}}"#
        case "add_todo", "push_branch":
            return #"{"id":"\#(id)","payload":{"type":"ack"}}"#
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

@MainActor
@Test func aRequestSucceedingWhileTheStreamIsDownKeepsReviewStale() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: reviewResponder())
    // Too slow to reconnect on its own within the test, so the stream stays
    // down for as long as the test needs it to.
    let session = DaemonSession(
        address: await daemon.address, token: "t",
        backoff: Backoff(base: .seconds(30), cap: .seconds(30)))
    try await session.connect()
    let store = ReviewStore(session: session, workspace: "w")
    await store.refreshAll()
    #expect(store.isStale == false)
    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))

    await daemon.endEventConnection()
    #expect(await eventually { @MainActor in store.isStale })

    // Each of these opens its own connection, so they succeed even though
    // the event stream is still down.
    await store.addTodo("write the changelog")
    await store.push()
    #expect(store.lastError == nil)
    #expect(store.actionOutput == "Done.")
    #expect(await session.connectionState != .connected)

    // The panels are still missing live updates, so they must still say so.
    #expect(store.isStale)

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func aPartialRefreshKeepsReviewStale() async throws {
    let daemon = try await MockDaemon()
    // Changes, workflow runs and todos answer; the checks summary does not.
    await daemon.respond(to: reviewResponder(checksFail: true))
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = ReviewStore(session: session, workspace: "w")

    await store.refreshAll()

    // The fetches after the failed one succeeded, but the checks on screen
    // were never refreshed, so the panel is not up to date.
    #expect(await session.connectionState == .connected)
    #expect(store.checks == nil)
    #expect(store.runs != nil)
    #expect(store.isStale)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func aFailedChecksFetchKeepsStaleAfterRefreshTodos() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: reviewResponder(checksFail: true))
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = ReviewStore(session: session, workspace: "w")

    await store.refreshChecks()
    #expect(store.checks == nil)
    #expect(store.isStale)

    await store.refreshTodos()

    // The todos came back, but the checks on screen are still the ones that
    // failed to refresh, so the store is not up to date.
    #expect(await session.connectionState == .connected)
    #expect(store.lastError == nil)
    #expect(store.isStale)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func aFailedChecksFetchKeepsStaleAfterRefreshChanges() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: reviewResponder(checksFail: true))
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = ReviewStore(session: session, workspace: "w")

    await store.refreshChecks()
    #expect(store.isStale)

    await store.refreshChanges()

    #expect(await session.connectionState == .connected)
    #expect(store.changesError == nil)
    #expect(store.isStale)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func aRunActionOnlyClearsItsOwnPanel() async throws {
    let daemon = try await MockDaemon()
    // Only the changes fetch fails; the push and the checks after it succeed.
    await daemon.respond(to: reviewResponder(changesFail: true))
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = ReviewStore(session: session, workspace: "w")

    await store.refreshChanges()
    #expect(store.changesError != nil)
    #expect(store.isStale)

    // The push ends by refetching the checks, which succeeds — but that is
    // the checks panel, not the changes panel that failed.
    await store.push()
    #expect(store.actionOutput == "Done.")
    #expect(store.checks != nil)
    #expect(store.runs != nil)
    #expect(await session.connectionState == .connected)
    #expect(store.isStale)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func anEventDrivenRefreshClearsOnlyChangesAndChecksNotTodos() async throws {
    let daemon = try await MockDaemon()
    // Changes and checks answer; todos do not.
    await daemon.respond(to: reviewResponder(todosFail: true))
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = ReviewStore(session: session, workspace: "w")
    let observing = Task { await store.observe() }
    await daemon.waitForSubscribes(1)
    try await Task.sleep(for: .milliseconds(150))

    await store.refreshTodos()
    #expect(store.isStale)
    let before = await daemon.receivedLines.count

    // An event the review store refetches changes and checks for — not todos.
    await daemon.push(#"{"id":"e1","payload":{"type":"inventory_changed","scope":"workspace","workspace":"w"}}"#)
    #expect(await eventually {
        await daemon.receivedLines.dropFirst(before).compactMap(requestType).contains("list_workflow_runs")
    })
    // Give the event-driven clear time to land, if it is going to.
    try await Task.sleep(for: .milliseconds(300))

    #expect(await daemon.receivedLines.dropFirst(before).compactMap(requestType).contains("list_todos") == false)
    #expect(await session.connectionState == .connected)
    #expect(store.isStale)

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}
