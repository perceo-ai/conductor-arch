import Foundation
import Observation

/// What the tap router reads: a workspace list it can look in and refetch.
/// `WorkspacesStore` in the app; a fake in tests.
@MainActor
public protocol ChatInventory: AnyObject {
    var workspaces: [WorkspaceSummary] { get }
    var chatThreads: [String: [ChatThread]] { get }
    var lastError: String? { get }
    /// Called after every successful `refresh()`.
    var onRefreshed: (@MainActor () -> Void)? { get set }
    func refresh() async
}

extension WorkspacesStore: ChatInventory {}

/// Turns a tapped notification into a chat to open, or a "no longer exists".
///
/// A tap often arrives when there is nothing to look in yet: it cold-launched
/// the app, or the phone slept and the socket is dead. The tap is held until
/// a list has loaded — `resolve()` runs on every successful refresh once
/// `attach(to:)` is called, including the refetch after a reconnect — so it is
/// never dropped. A failed or stale list is never trusted to say "gone".
@MainActor
@Observable
public final class NotificationTapRouter {
    /// The resolved tap, for the views to act on and then `clearRequest()`.
    public private(set) var request: ChatThreadLookup.Resolution?
    /// The list to resolve against: the active daemon's, or nil when none is
    /// connected.
    @ObservationIgnored public var inventory: @MainActor () -> (any ChatInventory)? = { nil }
    /// The daemon `inventory` belongs to; stamped taps from any other daemon
    /// resolve as not found.
    @ObservationIgnored public var activeDaemonID: @MainActor () -> String? = { nil }

    @ObservationIgnored private var pending: NotificationTap?
    @ObservationIgnored private var isResolving = false
    /// A `resolve()` arrived while one was running. The running one may be
    /// about to give up on a fetch that was sent while offline, after the
    /// newer call's list already loaded, so it must go round again.
    @ObservationIgnored private var resolveAgain = false

    public init() {}

    public var hasPendingTap: Bool { pending != nil }

    public func tapped(_ tap: NotificationTap) async {
        pending = tap
        await resolve()
    }

    public func clearRequest() {
        request = nil
    }

    /// Retries a held tap after each successful refresh of `store`.
    public func attach(to store: any ChatInventory) {
        store.onRefreshed = { [weak self] in
            guard let self, self.pending != nil else { return }
            Task { await self.resolve() }
        }
    }

    /// Resolves the held tap if there is a list to resolve it against. Does
    /// nothing, and keeps the tap, when there is none or it cannot be fetched.
    public func resolve() async {
        // One resolution at a time, so a tap racing a refresh cannot open the
        // same chat twice. A call that arrives meanwhile is not dropped: it
        // earns the running one another pass once this one finishes.
        guard !isResolving else {
            resolveAgain = true
            return
        }
        isResolving = true
        defer { isResolving = false }
        repeat {
            resolveAgain = false
            await resolvePass()
        } while resolveAgain && pending != nil
    }

    private func resolvePass() async {
        while let tap = pending, let store = inventory() {
            if store.lastError != nil { await store.refresh() }
            var answer = resolution(of: tap, in: store)
            // A miss refetches once before concluding the chat is gone: the
            // snapshot may predate the chat. A wrong-daemon tap needs no fetch.
            let isActiveDaemons = tap.daemonID == nil || tap.daemonID == activeDaemonID()
            if store.lastError == nil, isActiveDaemons, case .notFound = answer {
                await store.refresh()
                answer = resolution(of: tap, in: store)
            }
            // A reconnect or a newer tap during a fetch makes this answer
            // stale: go round again against the current list and tap.
            guard inventory() === store, pending == tap else { continue }
            guard store.lastError == nil else { return }
            pending = nil
            request = answer
        }
    }

    private func resolution(of tap: NotificationTap, in store: any ChatInventory) -> ChatThreadLookup.Resolution {
        ChatThreadLookup.resolve(
            tap, activeDaemonID: activeDaemonID(),
            workspaces: store.workspaces, chatThreads: store.chatThreads)
    }
}
