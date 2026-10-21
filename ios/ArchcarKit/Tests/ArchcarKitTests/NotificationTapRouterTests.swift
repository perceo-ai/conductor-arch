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
    var onRefreshed: (@MainActor () -> Void)?
    var online = true
    var snapshot: ([WorkspaceSummary], [String: [ChatThread]]) = ([], [:])
    var refreshes = 0
    /// When set, the next fetch stays in flight until `releaseHeldFetch()`.
    var holdNextFetch = false
    private var heldFetch: CheckedContinuation<Void, Never>?
    var hasHeldFetch: Bool { heldFetch != nil }

    func refresh() async {
        refreshes += 1
        // Whether a fetch succeeds is decided when it is sent: one sent while
        // offline fails even if the daemon is back by the time it times out.
        let succeeds = online
        if holdNextFetch {
            holdNextFetch = false
            await withCheckedContinuation { heldFetch = $0 }
        }
        if succeeds {
            (workspaces, chatThreads) = snapshot
            lastError = nil
            onRefreshed?()
        } else {
            lastError = "connection failed"
        }
    }

    func releaseHeldFetch() {
        heldFetch?.resume()
        heldFetch = nil
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

@MainActor
@Test func stampedPushFromAnInactiveDaemonIsNotFoundWithoutOpeningTheSameNumberedChat() async throws {
    let fake = FakeInventory()
    // The active daemon has its own thread 42 — an unrelated chat.
    fake.snapshot = ([try workspace(name: "billing")], ["billing": [try thread(id: 42)]])
    await fake.refresh()
    let router = NotificationTapRouter()
    router.inventory = { fake }
    router.activeDaemonSelfID = { "self-b" }

    await router.tapped(NotificationTap(threadID: 42, daemonID: nil, daemonSelfID: "self-a"))

    #expect(router.request == .notFound(threadID: 42))
    // No point refetching another daemon's list for a push that is
    // already known to be from a different daemon.
    #expect(fake.refreshes == 1)
}

/// The race behind the CI failure of the reconnect test's first version: the
/// tap's own refetch is still in flight (sent while offline) when the
/// reconnect's refetch succeeds. The retry that success triggers must not be
/// swallowed just because a resolution is already running and about to give
/// up on its failed fetch.
@MainActor
@Test func retryDuringAnInFlightFailingFetchIsNotSwallowed() async throws {
    let fake = FakeInventory()
    fake.online = false
    await fake.refresh()
    let router = NotificationTapRouter()
    router.inventory = { fake }
    router.attach(to: fake)

    // The tap's resolution refetches; that fetch was sent offline and hangs.
    fake.holdNextFetch = true
    let tapping = Task { await router.tapped(NotificationTap(threadID: 42, daemonID: nil)) }
    #expect(await eventually { @MainActor in fake.hasHeldFetch })

    // The daemon comes back and the reconnect's refetch succeeds, which asks
    // the router to retry while the first resolution is still running.
    fake.online = true
    fake.snapshot = ([try workspace(name: "checkout")], ["checkout": [try thread(id: 42)]])
    await fake.refresh()
    try await Task.sleep(for: .milliseconds(50))

    // Now the offline fetch fails. Nothing else will refresh.
    fake.releaseHeldFetch()
    await tapping.value

    let checkout = try workspace(name: "checkout")
    #expect(await eventually { @MainActor in router.request == .found(workspace: checkout, threadID: 42) })
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
    // Wait for the session itself to see the drop. `isStale` is no signal
    // here — the failed fetch above already set it — and `reconnectNow` does
    // nothing while the session still believes it is connected.
    #expect(await eventually { await session.connectionState != .connected })
    await session.reconnectNow()

    let checkout = try workspace(name: "checkout")
    #expect(await eventually { @MainActor in router.request == .found(workspace: checkout, threadID: 42) })

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}

@Test func heldTapIsResolvedAgainstTheReconnectsOwnLearnedSelfIDNotAStaleOne() async throws {
    let online = Flag()
    let daemon = try await MockDaemon()
    await daemon.stampHandshake(daemonSelfID: "self-v1")
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
    // Read straight from the session at resolve time, as the app does: no
    // cached copy that a reconnect's own refresh could outrun.
    router.activeDaemonSelfID = { await session.remoteDaemonSelfID }
    router.attach(to: store)
    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))

    await store.refresh()
    #expect(store.lastError != nil)
    // Stamped with the id the next handshake will report, not the current one.
    await router.tapped(NotificationTap(threadID: 42, daemonID: nil, daemonSelfID: "self-v2"))
    #expect(router.request == nil)
    #expect(router.hasPendingTap)

    // Back online with a new self-id; the event stream drops and the session
    // reconnects, whose refetch is the only thing that retries the tap.
    online.set(true)
    await daemon.stampHandshake(daemonSelfID: "self-v2")
    await daemon.endEventConnection()
    #expect(await eventually { await session.connectionState != .connected })
    await session.reconnectNow()

    let checkout = try workspace(name: "checkout")
    #expect(await eventually { @MainActor in router.request == .found(workspace: checkout, threadID: 42) })

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}
