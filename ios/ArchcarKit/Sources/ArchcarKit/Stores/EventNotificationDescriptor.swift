import Foundation

/// What the app already knows about the chat an event names, so a notification
/// can read "antix · fix the parser / Done in 4m 12s" instead of "Chat
/// finished / Thread 9 completed.". Every field is optional: a missing one
/// only costs detail, never the notification.
///
/// The wording built from it is mirrored by `event_notification` in
/// `crates/core/src/notifications.rs` (the APNs copy of the same event) and by
/// `eventNotifications.ts` in the desktop app. Change all three together.
public struct NotificationContext: Sendable, Equatable, Hashable {
    public let workspace: String?
    public let chatTitle: String?
    /// The model the chat runs, when recorded; `provider` is the fallback.
    public let model: String?
    public let provider: String?

    public init(
        workspace: String? = nil,
        chatTitle: String? = nil,
        model: String? = nil,
        provider: String? = nil
    ) {
        self.workspace = workspace
        self.chatTitle = chatTitle
        self.model = model
        self.provider = provider
    }

    /// The context for `thread`, as the chat list holds it.
    public init(workspace: String?, thread: ChatThread?) {
        self.init(
            workspace: workspace,
            chatTitle: thread?.title,
            model: thread?.model,
            provider: thread?.provider)
    }
}

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

    /// Longest chat title kept in a notification title. Past this the rest of
    /// the line (the workspace, which says *where*) is what gets pushed off
    /// screen.
    private static let chatTitleMax = 44
    /// Longest body. iOS shows roughly three lines, macOS two; past this a
    /// notification is a wall of text nobody reads at a glance.
    private static let bodyMax = 120

    /// The chat thread an event is about, so the caller can look up the chat
    /// before building the descriptor.
    public static func threadID(of event: ArchcarEvent) -> Int64? {
        switch event {
        case .providerInteractionRequested(let interaction): return interaction.threadID
        case .turnCompleted(_, let threadID, _, _): return threadID
        case .sessionError(_, let threadID, _): return threadID
        default: return nil
        }
    }

    public static func from(
        _ event: ArchcarEvent,
        context: NotificationContext = NotificationContext()
    ) -> EventNotificationDescriptor? {
        switch event {
        case .providerInteractionRequested(let interaction):
            // The interaction carries its own workspace; the chat title and
            // agent come from the chat list, when it has loaded them.
            let merged = NotificationContext(
                workspace: nonEmpty(interaction.workspace) ?? context.workspace,
                chatTitle: context.chatTitle,
                model: context.model,
                provider: nonEmpty(interaction.providerKey) ?? context.provider)
            return EventNotificationDescriptor(
                id: "interaction-\(interaction.id)",
                title: chatHeadline(merged, threadID: interaction.threadID),
                body: truncated(
                    prefixedDetail(
                        "Needs you",
                        joinedDetail(title: interaction.title, detail: interaction.detail)),
                    bodyMax),
                threadID: interaction.threadID)
        case .turnCompleted(let sessionID, let threadID, let rawStatus, let durationMS):
            let status = nonEmpty(rawStatus ?? "") ?? "completed"
            return EventNotificationDescriptor(
                id: "turn-\(sessionID)-\(threadID)-\(status)",
                title: chatHeadline(context, threadID: threadID),
                body: turnBody(status: status, durationMS: durationMS, context: context),
                threadID: threadID)
        case .sessionError(let sessionID, let threadID, let message):
            return EventNotificationDescriptor(
                id: "session-error-\(sessionID.map(String.init) ?? "unknown")-\(threadID.map(String.init) ?? "unknown")",
                title: chatHeadline(context, threadID: threadID),
                body: truncated(prefixedDetail("Failed", message), bodyMax),
                threadID: threadID)
        case .backgroundTaskUpdated(let rawTask):
            return backgroundTask(rawTask)
        default:
            return nil
        }
    }

    /// The notification title: which chat this is about, as "workspace · chat
    /// title". Falls back through whichever half is known, and to the thread
    /// number when neither is.
    private static func chatHeadline(
        _ context: NotificationContext,
        threadID: Int64?
    ) -> String {
        let workspace = context.workspace.flatMap(nonEmpty)
        let title = context.chatTitle.flatMap(nonEmpty).map { truncated($0, chatTitleMax) }
        switch (workspace, title) {
        case (let workspace?, let title?): return "\(workspace) \u{b7} \(title)"
        case (let workspace?, nil): return workspace
        case (nil, let title?): return title
        case (nil, nil): return threadID.map { "Thread \($0)" } ?? "Archductor"
        }
    }

    /// "Done in 4m 12s · Claude Opus 5": what happened, how long it took, who
    /// ran it. Enough to decide whether to go back to this chat without
    /// opening it.
    private static func turnBody(
        status: String,
        durationMS: UInt64?,
        context: NotificationContext
    ) -> String {
        let (label, preposition) = turnOutcome(status)
        var body = durationMS.map { "\(label) \(preposition) \(formatTurnDuration($0))" } ?? label
        if let agent = agentLabel(context) {
            body += " \u{b7} \(agent)"
        }
        return truncated(body, bodyMax)
    }

    /// How a finished turn reads, and the preposition its duration needs. An
    /// unknown status is shown as it arrived rather than being flattened into
    /// "stopped", which is what made every successful claude turn ("success")
    /// read as a failure.
    private static func turnOutcome(_ status: String) -> (String, String) {
        switch status.lowercased() {
        case "completed", "success", "succeeded", "ok": return ("Done", "in")
        case "failed", "error", "errored": return ("Failed", "after")
        case "interrupted", "cancelled", "canceled", "stopped", "aborted":
            return ("Stopped", "after")
        case "deferred", "queued", "paused": return ("Paused", "after")
        default: return (capitalized(status), "after")
        }
    }

    /// Who ran the turn: the model when the chat records one, else the
    /// provider.
    private static func agentLabel(_ context: NotificationContext) -> String? {
        if let model = context.model.flatMap(nonEmpty) { return modelLabel(model) }
        return context.provider.flatMap(nonEmpty).map(capitalized)
    }

    /// "claude-opus-5" -> "Claude Opus 5", "gpt-5.6-sol" -> "GPT 5.6 Sol".
    static func modelLabel(_ model: String) -> String {
        let longContext = model.hasSuffix("[1m]")
        let base = longContext ? String(model.dropLast(4)) : model
        var parts = base.split(whereSeparator: { $0 == "-" || $0 == "_" })
            .map { part -> String in
                part.lowercased() == "gpt" ? "GPT" : capitalized(String(part))
            }
        if longContext { parts.append("1M") }
        return parts.joined(separator: " ")
    }

    /// "840ms", "18.3s", "4m 12s" — the same shape as
    /// `format_provider_turn_duration` in the daemon, so a banner and the turn
    /// row in the chat read the same duration.
    static func formatTurnDuration(_ durationMS: UInt64) -> String {
        if durationMS < 1_000 { return "\(durationMS)ms" }
        if durationMS < 60_000 {
            return String(format: "%.1fs", Double(durationMS) / 1_000)
        }
        let totalSeconds = durationMS / 1_000
        return String(format: "%dm %02ds", totalSeconds / 60, totalSeconds % 60)
    }

    private static func capitalized(_ value: String) -> String {
        guard let first = value.first else { return "" }
        return first.uppercased() + value.dropFirst()
    }

    private static func nonEmpty(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// "Failed: codex exited" — the lead says what kind of event this is, the
    /// detail says what to do about it.
    private static func prefixedDetail(_ lead: String, _ detail: String) -> String {
        let detail = collapsed(detail)
        return detail.isEmpty ? lead : "\(lead): \(detail)"
    }

    /// "Approve command? — cargo test": the ask, then what it is about.
    private static func joinedDetail(title: String, detail: String) -> String {
        let title = collapsed(title)
        let detail = collapsed(detail)
        if title.isEmpty { return detail }
        if detail.isEmpty { return title }
        return "\(title) \u{2014} \(detail)"
    }

    /// Notification bodies are one line of plain text: a wrapped agent message
    /// or a multi-line error renders as a ragged block, so whitespace is
    /// collapsed before anything is measured or cut.
    private static func collapsed(_ value: String) -> String {
        value.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
    }

    /// Cuts at a word boundary, so a clipped line ends "so every…" rather than
    /// "so every s…". Falls back to a hard cut for a single long word (a path,
    /// a URL) that has no boundary to fall back to.
    private static func truncated(_ value: String, _ max: Int) -> String {
        let clean = collapsed(value)
        let characters = Array(clean)
        guard characters.count > max else { return clean }
        var kept = String(characters.prefix(max - 1))
        let nextIsBoundary = characters[max - 1].isWhitespace
        if !nextIsBoundary, let boundary = kept.lastIndex(of: " "), boundary > kept.startIndex {
            kept = String(kept[kept.startIndex..<boundary])
        }
        return "\(kept.trimmingCharacters(in: .whitespaces))\u{2026}"
    }

    private static func backgroundTask(_ rawTask: RawJSON) -> EventNotificationDescriptor? {
        guard
            let task = try? JSONDecoder().decode(BackgroundTaskNotificationPayload.self, from: rawTask.data),
            task.status == "ready" || task.status == "failed"
        else {
            return nil
        }
        let detail = nonEmpty(task.detail) ?? task.error.flatMap(nonEmpty) ?? ""
        return EventNotificationDescriptor(
            id: "background-task-\(task.id)-\(task.status)",
            title: chatHeadline(
                NotificationContext(workspace: task.workspaceName, chatTitle: task.title),
                threadID: nil),
            body: truncated(
                prefixedDetail(task.status == "ready" ? "Task ready" : "Task failed", detail),
                bodyMax),
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
