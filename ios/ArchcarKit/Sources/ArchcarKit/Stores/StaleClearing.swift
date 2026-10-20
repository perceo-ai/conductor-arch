import Foundation

/// A store whose `isStale` mark the shared clearing rule can guard.
///
/// The store bumps `staleRevision` every time it marks itself stale, so a
/// clear decided before a suspension can tell whether a mark landed since.
@MainActor
protocol StaleRevisioned: AnyObject {
    var staleRevision: Int { get }
}

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
    /// The pure rule: the mark may be lifted when the refetch it covers
    /// succeeded and the event stream is connected.
    static func mayClear(afterRefetchSucceeded succeeded: Bool, connected: Bool) -> Bool {
        succeeded && connected
    }

    /// Whether a clear decision made when the store's staleness revision was
    /// `revisionWhenDecided` is still valid now that it reads `currentRevision`.
    /// A store bumps its revision every time it marks itself stale, so a
    /// mismatch means a mark landed after the decision was made, and that
    /// mark must win.
    static func revisionStillValid(decidedAt revisionWhenDecided: Int, now currentRevision: Int) -> Bool {
        revisionWhenDecided == currentRevision
    }

    /// The rule as the stores apply it, asking `session` whether the stream is
    /// connected at the moment of clearing.
    ///
    /// Reading the connection state hops to the session actor, and the
    /// store's `observe()` can mark it stale on the main actor while this is
    /// suspended — the stream dropping mid-check. A decision computed before
    /// that mark would then clear it for the whole outage. So the store's
    /// revision is captured before the `await` and checked after it, and a
    /// clear is refused if any mark landed in between.
    @MainActor
    static func mayClear<Store: StaleRevisioned>(
        afterRefetchSucceeded succeeded: Bool,
        on session: DaemonSession,
        store: Store
    ) async -> Bool {
        guard succeeded else { return false }
        let revisionWhenDecided = store.staleRevision
        let connected = await session.connectionState == .connected
        guard revisionStillValid(decidedAt: revisionWhenDecided, now: store.staleRevision) else {
            // The store marked itself stale again while the connection was
            // being checked, as when observe() saw the stream drop: that mark
            // wins.
            return false
        }
        return mayClear(afterRefetchSucceeded: true, connected: connected)
    }
}
