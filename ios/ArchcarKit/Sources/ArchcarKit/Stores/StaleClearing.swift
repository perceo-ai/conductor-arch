import Foundation

/// The one rule for lifting a store's `isStale` mark.
///
/// Setting the mark is each store's own business — its `observe()` loop when
/// the event stream drops, or a request that fails. Clearing it is decided
/// here, so the chat, workspaces, review and terminal screens cannot drift
/// apart on what "up to date" means.
///
/// Clearing takes both halves. A `DaemonSession.request` runs on its own
/// one-shot connection, so one succeeding proves the daemon answered, not
/// that the long-lived event stream is back; and a stream that is back says
/// nothing about data that was not refetched since.
enum StaleClearing {
    /// Whether the mark may be lifted: the refetch it covers succeeded and
    /// the event stream is connected.
    static func mayClear(afterRefetchSucceeded succeeded: Bool, connected: Bool) -> Bool {
        succeeded && connected
    }

    /// The same rule, asking `session` whether the stream is connected at the
    /// moment of clearing.
    ///
    /// Answers whether to clear rather than the new value on purpose: the
    /// caller's `observe()` may mark the store stale during the `await`, and
    /// writing back a value read before it would undo that.
    static func mayClear(afterRefetchSucceeded succeeded: Bool, on session: DaemonSession) async -> Bool {
        guard succeeded else { return false }
        return mayClear(
            afterRefetchSucceeded: true, connected: await session.connectionState == .connected)
    }
}
