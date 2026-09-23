import Foundation
import Testing

@testable import ArchcarKit

/// The inventory snapshot the mock hands back for every refetch. Empty is
/// enough: these tests count round trips, they do not read rows.
private let emptySnapshot = #"{"id":"%@","payload":{"type":"inventory_snapshot","repositories":[],"workspaces":[],"chat_threads":{}}}"#

private func snapshotResponder(_ line: String) -> String? {
    guard line.contains("get_inventory_snapshot") else { return nil }
    guard let data = line.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let id = object["id"] as? String
    else { return nil }
    return emptySnapshot.replacingOccurrences(of: "%@", with: id)
}

private let inventoryChanged =
    #"{"id":"e","payload":{"type":"inventory_changed","scope":"workspace","workspace":"w"}}"#

@MainActor
@Test func aBurstOfEventsCostsOneInventorySnapshot() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: snapshotResponder)
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = WorkspacesStore(session: session)
    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))

    // One agent turn's worth of events. Before coalescing this was one full
    // inventory snapshot — and one TCP connection — per event.
    for _ in 0..<20 {
        await daemon.push(inventoryChanged)
    }
    try await Task.sleep(for: .milliseconds(800))

    #expect(store.refreshCount == 1)

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func anEventAfterTheBurstEarnsItsOwnSnapshot() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: snapshotResponder)
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = WorkspacesStore(session: session)
    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))

    await daemon.push(inventoryChanged)
    try await Task.sleep(for: .milliseconds(600))
    await daemon.push(inventoryChanged)
    try await Task.sleep(for: .milliseconds(600))

    // Coalescing must not become "drop": a quiet stream still tracks the daemon.
    #expect(store.refreshCount == 2)

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}
