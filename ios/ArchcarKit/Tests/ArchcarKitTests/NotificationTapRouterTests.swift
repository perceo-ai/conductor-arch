import Foundation
import Testing

@testable import ArchcarKit

private func workspace(name: String) throws -> WorkspaceSummary {
    let json = """
    {"id":1,"name":"\(name)","repository_name":"r","path":"/p/\(name)","branch":"b",
    "base_ref":"main","status":"active","open_todos":0,"blocked_tasks":0,
    "active_sessions":0,"awaiting_input":false,"run_running":false,"changed_files":0,
    "diff_additions":0,"diff_deletions":0,"updated_at":"1000"}
    """
    return try JSONDecoder().decode(WorkspaceSummary.self, from: Data(json.utf8))
}

private func thread(id: Int64) throws -> ChatThread {
    try JSONDecoder().decode(ChatThread.self, from: Data("""
    {"id":\(id),"provider":"claude","title":"t","status":"idle","updated_at":"1000"}
    """.utf8))
}

/// A workspace list whose fetches fail while `online` is false, standing in
/// for a daemon the phone cannot reach.
@MainActor
private final class FakeInventory: ChatInventory {
    var workspaces: [WorkspaceSummary] = []
    var chatThreads: [String: [ChatThread]] = [:]
    var lastError: String?
    var online = true
    var snapshot: ([WorkspaceSummary], [String: [ChatThread]]) = ([], [:])
    var refreshes = 0

    func refresh() async {
        refreshes += 1
        if online {
            (workspaces, chatThreads) = snapshot
            lastError = nil
        } else {
            lastError = "connection failed"
        }
    }
}

@MainActor
@Test func tapWithNoDaemonConnectedIsHeldNotDropped() async throws {
    let router = NotificationTapRouter()
    await router.tapped(NotificationTap(threadID: 42, daemonID: "d"))

    #expect(router.request == nil)
    #expect(router.hasPendingTap)

    let fake = FakeInventory()
    fake.snapshot = ([try workspace(name: "checkout")], ["checkout": [try thread(id: 42)]])
    await fake.refresh()
    router.inventory = { fake }
    router.activeDaemonID = { "d" }
    await router.resolve()

    let checkout = try workspace(name: "checkout")
    #expect(router.request == .found(workspace: checkout, threadID: 42))
    #expect(!router.hasPendingTap)
}

@MainActor
@Test func failedFetchKeepsTheTapUntilAFetchSucceeds() async throws {
    let fake = FakeInventory()
    fake.online = false
    await fake.refresh()
    let router = NotificationTapRouter()
    router.inventory = { fake }

    await router.tapped(NotificationTap(threadID: 42, daemonID: nil))

    // Unreachable is not "gone": no alert, and the tap is still held.
    #expect(router.request == nil)
    #expect(router.hasPendingTap)

    fake.online = true
    fake.snapshot = ([try workspace(name: "checkout")], ["checkout": [try thread(id: 42)]])
    await router.resolve()

    let checkout = try workspace(name: "checkout")
    #expect(router.request == .found(workspace: checkout, threadID: 42))
}

@MainActor
@Test func missingChatResolvesToNotFoundAfterOneRefetch() async throws {
    let fake = FakeInventory()
    fake.snapshot = ([try workspace(name: "checkout")], ["checkout": [try thread(id: 7)]])
    await fake.refresh()
    let router = NotificationTapRouter()
    router.inventory = { fake }

    await router.tapped(NotificationTap(threadID: 42, daemonID: nil))

    #expect(router.request == .notFound(threadID: 42))
    #expect(fake.refreshes == 2)
    #expect(!router.hasPendingTap)
}

@MainActor
@Test func tapFromAnInactiveDaemonIsNotFoundWithoutOpeningTheSameNumberedChat() async throws {
    let fake = FakeInventory()
    // The active daemon has its own thread 42 — an unrelated chat.
    fake.snapshot = ([try workspace(name: "billing")], ["billing": [try thread(id: 42)]])
    await fake.refresh()
    let router = NotificationTapRouter()
    router.inventory = { fake }
    router.activeDaemonID = { "daemon-b" }

    await router.tapped(NotificationTap(threadID: 42, daemonID: "daemon-a"))

    #expect(router.request == .notFound(threadID: 42))
    // No point refetching another daemon's list for it.
    #expect(fake.refreshes == 1)
}

/// The snapshot `ReconnectDaemon` serves once it is back: workspace
/// `checkout` with chat 42.
private let checkoutSnapshot = """
{"type":"inventory_snapshot","repositories":[],"workspaces":[{"id":1,"name":"checkout",\
"repository_name":"r","path":"/p/checkout","branch":"b","base_ref":"main","status":"active",\
"open_todos":0,"blocked_tasks":0,"active_sessions":0,"awaiting_input":false,"run_running":false,\
"changed_files":0,"diff_additions":0,"diff_deletions":0,"updated_at":"1000"}],\
"chat_threads":{"checkout":[{"id":42,"provider":"claude","title":"t","status":"idle","updated_at":"1000"}]}}
"""

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set(_ newValue: Bool) { lock.withLock { value = newValue } }
    func get() -> Bool { lock.withLock { value } }
}

/// The QA scenario: the phone slept, the tap arrives while the daemon cannot
/// be reached, and the connection comes back on its own (not through a
/// foreground). The reconnect's refetch must open the chat.
@MainActor
@Test func heldTapResolvesOnTheRefetchAfterAReconnect() async throws {
    let online = Flag()
    let daemon = try await MockDaemon()
    await daemon.respond { line in
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let id = object["id"] as? String,
              let payload = object["payload"] as? [String: Any],
              payload["type"] as? String == "get_inventory_snapshot" else { return nil }
        return online.get()
            ? #"{"id":"\#(id)","payload":\#(checkoutSnapshot)}"#
            : #"{"id":"\#(id)","payload":{"type":"error","message":"daemon unreachable"}}"#
    }
    let session = DaemonSession(
        address: await daemon.address, token: "t",
        backoff: Backoff(base: .seconds(30), cap: .seconds(30)))
    try await session.connect()
    let store = WorkspacesStore(session: session)
    let router = NotificationTapRouter()
    router.inventory = { store }
    router.attach(to: store)
    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))

    await store.refresh()
    #expect(store.lastError != nil)
    await router.tapped(NotificationTap(threadID: 42, daemonID: nil))
    #expect(router.request == nil)
    #expect(router.hasPendingTap)

    // Back online; the event stream drops and the session reconnects, which
    // refetches the list. Nothing else calls the router.
    online.set(true)
    await daemon.endEventConnection()
    #expect(await eventually { @MainActor in store.isStale })
    await session.reconnectNow()

    let checkout = try workspace(name: "checkout")
    #expect(await eventually { @MainActor in router.request == .found(workspace: checkout, threadID: 42) })

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}
