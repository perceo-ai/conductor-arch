import Foundation
import Testing

@testable import ArchcarKit

private func replyID(_ line: String) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
        return nil
    }
    return object["id"] as? String
}

private func requestType(_ line: String) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          let payload = object["payload"] as? [String: Any] else { return nil }
    return payload["type"] as? String
}

@Test func routesResponseBackToItsRequest() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { line in
        guard let id = replyID(line) else { return nil }
        return #"{"id":"\#(id)","payload":{"type":"workspaces","workspaces":[]}}"#
    }

    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let response = try await session.request(ListWorkspacesRequest())
    guard case .workspaces(let workspaces) = response else {
        Issue.record("expected workspaces, got \(response)")
        return
    }
    #expect(workspaces.isEmpty)
    #expect(await session.connectionState == .connected)
    await session.disconnect()
    await daemon.stop()
}

@Test func concurrentRequestsResolveIndependently() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { line in
        guard let id = replyID(line), let type = requestType(line) else { return nil }
        if type == "list_workspaces" {
            return #"{"id":"\#(id)","payload":{"type":"workspaces","workspaces":[]}}"#
        }
        if type == "list_repositories" {
            return #"{"id":"\#(id)","payload":{"type":"repositories","repositories":[]}}"#
        }
        return nil
    }

    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    async let first = session.request(ListWorkspacesRequest())
    async let second = session.request(ListRepositoriesRequest())
    let (workspaces, repositories) = try await (first, second)
    guard case .workspaces = workspaces, case .repositories = repositories else {
        Issue.record("responses crossed wires")
        return
    }
    await session.disconnect()
    await daemon.stop()
}

/// The connect handshake is where the client learns the daemon's self-id —
/// the one a fresh APNs push is stamped with. An older daemon's reply has
/// none, and connecting still works.
@Test func connectLearnsTheDaemonSelfIDFromTheHandshake() async throws {
    let stamped = try await MockDaemon()
    await stamped.stampHandshake(daemonSelfID: "self-a")
    let session = DaemonSession(address: await stamped.address, token: "t")
    try await session.connect()
    #expect(await session.remoteDaemonSelfID == "self-a")
    await session.disconnect()
    await stamped.stop()

    let older = try await MockDaemon()
    let olderSession = DaemonSession(address: await older.address, token: "t")
    try await olderSession.connect()
    #expect(await olderSession.remoteDaemonSelfID == nil)
    #expect(await olderSession.connectionState == .connected)
    await olderSession.disconnect()
    await older.stop()
}

@Test func daemonErrorSurfacesAsThrownError() async throws {
    let daemon = try await MockDaemon()
    // Only the real request errors; the handshake probe is answered normally,
    // the way a daemon that is up but asked for something missing behaves.
    await daemon.respond { line in
        guard let id = replyID(line), requestType(line) == "list_workspaces" else { return nil }
        return #"{"id":"\#(id)","payload":{"type":"error","message":"no such workspace"}}"#
    }

    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    await #expect(throws: DaemonSessionError.daemon("no such workspace")) {
        _ = try await session.request(ListWorkspacesRequest())
    }
    await session.disconnect()
    await daemon.stop()
}

@Test func authenticationFailureIsItsOwnError() async throws {
    let daemon = try await MockDaemon()
    await daemon.requireToken("right")

    let session = DaemonSession(address: await daemon.address, token: "wrong")
    await #expect(throws: DaemonSessionError.authenticationFailed) {
        try await session.connect()
        _ = try await session.request(ListWorkspacesRequest())
    }
    await daemon.stop()
}

@Test func subscribesOnASecondConnectionAndStreamsEvents() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { _ in nil }

    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let events = await session.events

    // The daemon serves one request per connection, so the handshake probe
    // used a connection of its own and the only one still open is the
    // subscriber.
    #expect(await daemon.connectionCount == 2)

    await daemon.push(#"{"id":"e1","payload":{"type":"inventory_changed","scope":"workspace","workspace":"columbia"}}"#)

    var received: [ArchcarEvent] = []
    for await event in events {
        received.append(event)
        break
    }
    #expect(received.count == 1)
    await session.disconnect()
    await daemon.stop()
}

private let inventoryChanged =
    #"{"id":"e1","payload":{"type":"inventory_changed","scope":"workspace","workspace":"w"}}"#

/// A schedule short enough that a reconnect test does not sit out the
/// production half-second.
private let quickBackoff = Backoff(base: .milliseconds(20), cap: .milliseconds(200))

@Test func droppedEventStreamFinishesTheSubscriber() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { _ in nil }
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let events = await session.events
    let drained = Task { for await _ in events {} }

    await daemon.endEventConnection()

    // Before the fix this loop waited forever: the connection ended but
    // nothing finished the subscriber's stream.
    #expect(await finishes(drained))
    await session.disconnect()
    await daemon.stop()
}

@Test func reconnectsOnItsOwnAfterTheEventStreamDrops() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { _ in nil }
    let session = DaemonSession(address: await daemon.address, token: "t", backoff: quickBackoff)
    try await session.connect()
    let first = await session.events
    let drained = Task { for await _ in first {} }

    await daemon.endEventConnection()
    #expect(await finishes(drained))

    // Nobody calls `connect` again: the session's own retry loop does.
    await daemon.waitForSubscribes(2)
    #expect(await daemon.subscribeCount == 2)
    #expect(await eventually { await session.connectionState == .connected })

    await session.waitUntilConnected()
    let second = await session.events
    let received = Task { () -> Bool in
        for await _ in second { return true }
        return false
    }
    await daemon.push(inventoryChanged)
    #expect(await finishes(received))
    #expect(await received.value)

    await session.disconnect()
    await daemon.stop()
}

@Test func reconnectNowSkipsTheBackoffWait() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { _ in nil }
    // A wait far longer than the test allows: only a forced attempt can
    // reconnect in time.
    let session = DaemonSession(
        address: await daemon.address, token: "t",
        backoff: Backoff(base: .seconds(30), cap: .seconds(30)))
    try await session.connect()
    let events = await session.events
    let drained = Task { for await _ in events {} }
    await daemon.endEventConnection()
    #expect(await finishes(drained))
    #expect(await session.connectionState == .disconnected)

    await session.reconnectNow()

    await daemon.waitForSubscribes(2)
    #expect(await eventually { await session.connectionState == .connected })
    await session.disconnect()
    await daemon.stop()
}

@Test func deliberateDisconnectDoesNotReconnect() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { _ in nil }
    let session = DaemonSession(address: await daemon.address, token: "t", backoff: quickBackoff)
    try await session.connect()
    await daemon.waitForSubscribes(1)

    await session.disconnect()
    await session.reconnectNow()
    try await Task.sleep(for: .milliseconds(300))

    #expect(await daemon.subscribeCount == 1)
    #expect(await session.connectionState == .disconnected)
    await daemon.stop()
}

@Test func remembersTheSessionBehindEachThread() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { _ in nil }
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    await daemon.waitForSubscribes(1)

    await daemon.push(
        #"{"id":"e1","payload":{"type":"session_started","session_id":3,"thread_id":7,"workspace":"w","kind":"codex","pid":900}}"#)
    #expect(await eventually { await session.cachedSessionID(forThread: 7) == 3 })
    #expect(await session.cachedSessionID(forThread: 8) == nil)

    await daemon.push(#"{"id":"e2","payload":{"type":"session_exited","session_id":3,"exit_code":0}}"#)
    #expect(await eventually { await session.cachedSessionID(forThread: 7) == nil })

    await session.disconnect()
    await daemon.stop()
}
