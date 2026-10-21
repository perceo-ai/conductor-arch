import Foundation

/// What a tapped notification points at.
///
/// `daemonID` is the paired daemon that delivered it. Thread ids are per-daemon
/// SQLite rowids, so thread 42 on one daemon is an unrelated chat on another;
/// a tap is only resolved against the daemon it came from. Local notifications
/// carry it. APNs pushes do not, so for those it is nil.
///
/// `daemonSelfID` is the daemon's own stable self-id, stamped on a fresh APNs
/// push. Nil for local notifications and for pushes from an older daemon. It
/// is matched against the active session's learned self-id
/// (`DaemonSession.remoteDaemonSelfID`), never against `SavedDaemon.id` — the
/// two are separate identity spaces.
public struct NotificationTap: Sendable, Equatable {
    public let threadID: Int64
    public let daemonID: String?
    public let daemonSelfID: String?

    public init(threadID: Int64, daemonID: String?, daemonSelfID: String? = nil) {
        self.threadID = threadID
        self.daemonID = daemonID
        self.daemonSelfID = daemonSelfID
    }
}

/// Finds the workspace a chat thread belongs to, from the inventory snapshot
/// the workspace list already holds.
///
/// Notifications carry only a `thread_id`; this is what turns one into "open
/// that chat" and "the checkout chat finished" without a daemon round trip or
/// a payload change.
public enum ChatThreadLookup {
    public enum Resolution: Sendable, Equatable {
        case found(workspace: WorkspaceSummary, threadID: Int64)
        /// The snapshot has no such thread, or its workspace is gone: the chat
        /// was deleted since the notification was sent.
        case notFound(threadID: Int64)
    }

    /// The name of the workspace that owns `threadID`, or nil when the
    /// snapshot does not list it. Archived threads still count: their chat
    /// can still be opened and read.
    public static func workspaceName(
        forThread threadID: Int64,
        in chatThreads: [String: [ChatThread]]
    ) -> String? {
        // Sorted so a (malformed) thread listed under two workspaces resolves
        // the same way every time rather than by dictionary order.
        chatThreads.keys.sorted().first { name in
            chatThreads[name]?.contains { $0.id == threadID } ?? false
        }
    }

    /// Resolves a tap against the active daemon's snapshot. A tap stamped with
    /// a different daemon is `.notFound` without looking: matching its thread
    /// number here would open an unrelated chat, which is worse than none.
    public static func resolve(
        _ tap: NotificationTap,
        activeDaemonID: String?,
        activeDaemonSelfID: String? = nil,
        workspaces: [WorkspaceSummary],
        chatThreads: [String: [ChatThread]]
    ) -> Resolution {
        if isFromAnotherDaemon(tap, activeDaemonID: activeDaemonID, activeDaemonSelfID: activeDaemonSelfID) {
            return .notFound(threadID: tap.threadID)
        }
        return resolve(threadID: tap.threadID, workspaces: workspaces, chatThreads: chatThreads)
    }

    /// Whether `tap` is known to come from a daemon other than the active one.
    ///
    /// A push's self-id only counts when both sides have one. Unstamped (an
    /// older daemon) or not learned yet (an upgraded app that has not
    /// reconnected) routes against the active daemon, as before stamping
    /// existed: the hole stays open until the next connect learns the id,
    /// rather than every push breaking after an upgrade.
    public static func isFromAnotherDaemon(
        _ tap: NotificationTap, activeDaemonID: String?, activeDaemonSelfID: String?
    ) -> Bool {
        if let daemonID = tap.daemonID, daemonID != activeDaemonID { return true }
        if let selfID = tap.daemonSelfID, let activeSelfID = activeDaemonSelfID, selfID != activeSelfID {
            return true
        }
        return false
    }

    public static func resolve(
        threadID: Int64,
        workspaces: [WorkspaceSummary],
        chatThreads: [String: [ChatThread]]
    ) -> Resolution {
        guard
            let name = workspaceName(forThread: threadID, in: chatThreads),
            let workspace = workspaces.first(where: { $0.name == name })
        else {
            return .notFound(threadID: threadID)
        }
        return .found(workspace: workspace, threadID: threadID)
    }

    /// The chat, and the daemon if stamped, a tapped notification points at.
    public static func tap(fromUserInfo userInfo: [AnyHashable: Any]) -> NotificationTap? {
        guard let threadID = threadID(fromUserInfo: userInfo) else { return nil }
        let daemonID = (userInfo["daemon_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let daemonSelfID = (userInfo["daemon_self_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return NotificationTap(threadID: threadID, daemonID: daemonID, daemonSelfID: daemonSelfID)
    }

    /// The `thread_id` a tapped notification carries.
    ///
    /// Local notifications store it as an `Int64`; an APNs payload is decoded
    /// from JSON, so the same key arrives as an `NSNumber` (or, from a sender
    /// that quotes it, a string). Anything else means the notification is not
    /// about a chat.
    public static func threadID(fromUserInfo userInfo: [AnyHashable: Any]) -> Int64? {
        switch userInfo["thread_id"] {
        case let value as Int64:
            return value
        case let value as Int:
            return Int64(value)
        case let value as NSNumber:
            // A JSON 1.5 would otherwise truncate to thread 1.
            let int = value.int64Value
            return NSNumber(value: int) == value ? int : nil
        case let value as String:
            return Int64(value.trimmingCharacters(in: .whitespaces))
        default:
            return nil
        }
    }
}

extension WorkspacesStore {
    /// See ``ChatThreadLookup/workspaceName(forThread:in:)``.
    public func workspaceName(forThread threadID: Int64) -> String? {
        ChatThreadLookup.workspaceName(forThread: threadID, in: chatThreads)
    }
}
