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

    public static func from(_ event: ArchcarEvent) -> EventNotificationDescriptor? {
        switch event {
        case .providerInteractionRequested(let interaction):
            EventNotificationDescriptor(
                id: "interaction-\(interaction.id)",
                title: "Input required",
                body: joinedBody(title: interaction.title, detail: interaction.detail),
                threadID: interaction.threadID)
        case .turnCompleted(let sessionID, let threadID, let status):
            completedTurn(sessionID: sessionID, threadID: threadID, status: status)
        case .sessionError(let sessionID, let threadID, let message):
            EventNotificationDescriptor(
                id: "session-error-\(sessionID.map(String.init) ?? "unknown")-\(threadID.map(String.init) ?? "unknown")",
                title: "Chat failed",
                body: message,
                threadID: threadID)
        case .backgroundTaskUpdated(let rawTask):
            backgroundTask(rawTask)
        default:
            nil
        }
    }

    private static func completedTurn(
        sessionID: Int64,
        threadID: Int64,
        status rawStatus: String?
    ) -> EventNotificationDescriptor {
        let status = rawStatus?.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalStatus = status?.isEmpty == false ? status! : "completed"
        return EventNotificationDescriptor(
            id: "turn-\(sessionID)-\(threadID)-\(finalStatus)",
            title: finalStatus == "completed" ? "Chat finished" : "Chat stopped",
            body: "Thread \(threadID) \(finalStatus).",
            threadID: threadID)
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
