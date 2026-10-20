import Foundation

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

    /// See ``ChatThreadLookup/resolve(threadID:workspaces:chatThreads:)``.
    public func resolveThread(_ threadID: Int64) -> ChatThreadLookup.Resolution {
        ChatThreadLookup.resolve(threadID: threadID, workspaces: workspaces, chatThreads: chatThreads)
    }
}
