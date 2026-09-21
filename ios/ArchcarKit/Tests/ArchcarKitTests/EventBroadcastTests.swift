import Foundation
import Testing

@testable import ArchcarKit

@Test func everySubscriberSeesEveryEvent() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { _ in nil }
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()

    // Chat, review and terminal all observe at once. A shared AsyncStream would
    // hand each event to exactly one of them, so two would miss it entirely.
    let first = await session.events
    let second = await session.events

    let collector = Task { () -> (ArchcarEvent?, ArchcarEvent?) in
        async let a = first.first { _ in true }
        async let b = second.first { _ in true }
        return await (a, b)
    }
    try await Task.sleep(for: .milliseconds(150))
    await daemon.push(
        #"{"id":"e1","payload":{"type":"inventory_changed","scope":"workspace","workspace":"w"}}"#)

    let received = await collector.value
    #expect(received.0 != nil)
    #expect(received.1 != nil)

    await session.disconnect()
    await daemon.stop()
}
