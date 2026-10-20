import Foundation

public struct EventNotificationDescriptor: Sendable, Equatable, Hashable {
    public let id: String
    public let title: String
    public let body: String
    public let threadID: Int64?

    public init(id: String, title: String, body: String, threadID: Int64?) {
        self.id = id
        self.title = title
        self.body = body
        self.threadID = threadID
    }

    /// The chat thread an event is about, so the caller can look up which
    /// workspace to name before building the descriptor.
    public static func threadID(of event: ArchcarEvent) -> Int64? {
        switch event {
        case .providerInteractionRequested(let interaction): return interaction.threadID
        case .turnCompleted(_, let threadID, _): return threadID
        case .sessionError(_, let threadID, _): return threadID
        default: return nil
        }
    }

    /// - Parameter workspaceName: the workspace that owns the event's thread,
    ///   when the caller could resolve it. Without it the text falls back to
    ///   naming the thread number. Interactions carry their own workspace.
    ///
    /// The wording matches `event_notification` in
    /// `crates/core/src/notifications.rs`, which renders the APNs copy of the
    /// same event.
    public static func from(
        _ event: ArchcarEvent,
        workspaceName: String? = nil
    ) -> EventNotificationDescriptor? {
        let workspace = workspaceName.flatMap(nonEmpty)
        switch event {
        case .providerInteractionRequested(let interaction):
            return EventNotificationDescriptor(
                id: "interaction-\(interaction.id)",
                title: "Input required",
                body: prefixed(
                    joinedBody(title: interaction.title, detail: interaction.detail),
                    workspace: nonEmpty(interaction.workspace) ?? workspace),
                threadID: interaction.threadID)
        case .turnCompleted(let sessionID, let threadID, let status):
            return completedTurn(sessionID: sessionID, threadID: threadID, status: status, workspace: workspace)
        case .sessionError(let sessionID, let threadID, let message):
            return EventNotificationDescriptor(
                id: "session-error-\(sessionID.map(String.init) ?? "unknown")-\(threadID.map(String.init) ?? "unknown")",
                title: "Chat failed",
                body: prefixed(message, workspace: workspace),
                threadID: threadID)
        case .backgroundTaskUpdated(let rawTask):
            return backgroundTask(rawTask)
        default:
            return nil
        }
    }

    private static func completedTurn(
        sessionID: Int64,
        threadID: Int64,
        status rawStatus: String?,
        workspace: String?
    ) -> EventNotificationDescriptor {
        let status = rawStatus?.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalStatus = status?.isEmpty == false ? status! : "completed"
        return EventNotificationDescriptor(
            id: "turn-\(sessionID)-\(threadID)-\(finalStatus)",
            title: finalStatus == "completed" ? "Chat finished" : "Chat stopped",
            body: workspace.map { "The chat in \($0) \(finalStatus)." } ?? "Thread \(threadID) \(finalStatus).",
            threadID: threadID)
    }

    private static func nonEmpty(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func prefixed(_ body: String, workspace: String?) -> String {
        guard let workspace else { return body }
        return body.isEmpty ? workspace : "\(workspace): \(body)"
    }

    private static func joinedBody(title: String, detail: String) -> String {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanDetail = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleanTitle.isEmpty { return cleanDetail }
        if cleanDetail.isEmpty { return cleanTitle }
        return "\(cleanTitle) - \(cleanDetail)"
    }

    private static func backgroundTask(_ rawTask: RawJSON) -> EventNotificationDescriptor? {
        guard
            let task = try? JSONDecoder().decode(BackgroundTaskNotificationPayload.self, from: rawTask.data),
            task.status == "ready" || task.status == "failed"
        else {
            return nil
        }
        let detail = task.detail.isEmpty ? (task.error ?? task.status) : task.detail
        let workspace = task.workspaceName.map { " (\($0))" } ?? ""
        return EventNotificationDescriptor(
            id: "background-task-\(task.id)-\(task.status)",
            title: task.status == "ready" ? "Background task ready" : "Background task failed",
            body: "#\(task.id) \(task.title)\(workspace): \(detail)",
            threadID: nil)
    }
}

private struct BackgroundTaskNotificationPayload: Decodable {
    let id: Int64
    let title: String
    let status: String
    let detail: String
    let error: String?
    let workspaceName: String?

    private enum CodingKeys: String, CodingKey {
        case id, title, status, detail, error
        case workspaceName = "workspace_name"
    }
}
