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

    // Two sockets: one for commands, one held open by subscribe, because the
    // daemon refuses subscribe on a connection that does anything else.
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
