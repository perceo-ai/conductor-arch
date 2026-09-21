import Foundation

/// A JSON subtree kept verbatim.
///
/// Some events carry rich records (`BackgroundTask`, session capabilities)
/// that no view reads yet. Holding the bytes means the phase that adds those
/// views types them without changing the event plumbing, and means an
/// unfamiliar field never fails the decode.
public struct RawJSON: Decodable, Sendable, Equatable {
    public let data: Data

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(JSONFragment.self)
        data = try JSONEncoder().encode(value)
    }
}

/// Minimal any-JSON representation, used only to re-serialize a subtree.
private enum JSONFragment: Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONFragment])
    case object([String: JSONFragment])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONFragment].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONFragment].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value):
            // Re-encode whole numbers as integers so `id: 9` does not come back
            // as `9.0` and break an `as? Int` on the far side.
            if value == value.rounded(), abs(value) < 9_007_199_254_740_992 {
                try container.encode(Int64(value))
            } else {
                try container.encode(value)
            }
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// Everything the daemon pushes on a `Subscribe` connection.
///
/// Events are thin by design — mostly identifiers. The app treats them as
/// invalidation signals and refetches the projection, exactly as the desktop
/// does, so the two surfaces can never disagree about what the state is.
public enum ArchcarEvent: Sendable {
    case sessionSpawnQueued(workspace: String, kind: SessionKind)
    case sessionStarted(sessionID: Int64, threadID: Int64, workspace: String, kind: SessionKind, pid: Int)
    case sessionReady(sessionID: Int64, threadID: Int64)
    case sessionCapabilitiesChanged(sessionID: Int64, threadID: Int64, capabilities: RawJSON)
    case turnCompleted(sessionID: Int64, threadID: Int64, status: String?)
    case sessionScreenUpdated(sessionID: Int64)
    case sessionMessagesUpdated(threadID: Int64)
    case chatQueueUpdated(threadID: Int64)
    case chatPlanUpdated(threadID: Int64, planMode: Bool, planPath: String?)
    case sessionExited(sessionID: Int64, exitCode: Int?)
    case sessionError(sessionID: Int64?, threadID: Int64?, message: String)
    case providerInteractionRequested(ProviderInteraction)
    case providerInteractionResolved(ProviderInteraction)
    case backgroundTaskUpdated(RawJSON)
    case summaryUpdated(workspace: String, summaryID: Int64, scopeType: String, scopeID: Int64)
    case taskUpdated(workspace: String, taskID: Int64, status: String)
    case workspaceRenamed(oldName: String, newName: String)
    case chatThreadRenamed(threadID: Int64, title: String)
    case inventoryChanged(scope: String, workspace: String?, repository: String?)
    case unknown(type: String)

    public static let knownTypeNames: Set<String> = [
        "session_spawn_queued", "session_started", "session_ready",
        "session_capabilities_changed", "turn_completed", "session_screen_updated",
        "session_messages_updated", "chat_queue_updated", "chat_plan_updated",
        "session_exited", "session_error", "provider_interaction_requested",
        "provider_interaction_resolved", "background_task_updated", "summary_updated",
        "task_updated", "workspace_renamed", "chat_thread_renamed", "inventory_changed"
    ]
}

extension ArchcarEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type
        case workspace, kind, pid, status, message, scope, repository, title, capabilities
        case interaction, task
        case summaryID = "summary_id", scopeType = "scope_type"
        case scopeID = "scope_id", taskID = "task_id"
        case sessionID = "session_id", threadID = "thread_id"
        case exitCode = "exit_code", planMode = "plan_mode", planPath = "plan_path"
        case oldName = "old_name", newName = "new_name"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "session_spawn_queued":
            self = .sessionSpawnQueued(
                workspace: try c.decode(String.self, forKey: .workspace),
                kind: try c.decode(SessionKind.self, forKey: .kind))
        case "session_started":
            self = .sessionStarted(
                sessionID: try c.decode(Int64.self, forKey: .sessionID),
                threadID: try c.decode(Int64.self, forKey: .threadID),
                workspace: try c.decode(String.self, forKey: .workspace),
                kind: try c.decode(SessionKind.self, forKey: .kind),
                pid: try c.decode(Int.self, forKey: .pid))
        case "session_ready":
            self = .sessionReady(
                sessionID: try c.decode(Int64.self, forKey: .sessionID),
                threadID: try c.decode(Int64.self, forKey: .threadID))
        case "session_capabilities_changed":
            self = .sessionCapabilitiesChanged(
                sessionID: try c.decode(Int64.self, forKey: .sessionID),
                threadID: try c.decode(Int64.self, forKey: .threadID),
                capabilities: try c.decode(RawJSON.self, forKey: .capabilities))
        case "turn_completed":
            self = .turnCompleted(
                sessionID: try c.decode(Int64.self, forKey: .sessionID),
                threadID: try c.decode(Int64.self, forKey: .threadID),
                status: try c.decodeIfPresent(String.self, forKey: .status))
        case "session_screen_updated":
            self = .sessionScreenUpdated(sessionID: try c.decode(Int64.self, forKey: .sessionID))
        case "session_messages_updated":
            self = .sessionMessagesUpdated(threadID: try c.decode(Int64.self, forKey: .threadID))
        case "chat_queue_updated":
            self = .chatQueueUpdated(threadID: try c.decode(Int64.self, forKey: .threadID))
        case "chat_plan_updated":
            self = .chatPlanUpdated(
                threadID: try c.decode(Int64.self, forKey: .threadID),
                planMode: try c.decode(Bool.self, forKey: .planMode),
                planPath: try c.decodeIfPresent(String.self, forKey: .planPath))
        case "session_exited":
            self = .sessionExited(
                sessionID: try c.decode(Int64.self, forKey: .sessionID),
                exitCode: try c.decodeIfPresent(Int.self, forKey: .exitCode))
        case "session_error":
            self = .sessionError(
                sessionID: try c.decodeIfPresent(Int64.self, forKey: .sessionID),
                threadID: try c.decodeIfPresent(Int64.self, forKey: .threadID),
                message: try c.decode(String.self, forKey: .message))
        case "provider_interaction_requested":
            self = .providerInteractionRequested(
                try c.decode(ProviderInteraction.self, forKey: .interaction))
        case "provider_interaction_resolved":
            self = .providerInteractionResolved(
                try c.decode(ProviderInteraction.self, forKey: .interaction))
        case "background_task_updated":
            self = .backgroundTaskUpdated(try c.decode(RawJSON.self, forKey: .task))
        case "summary_updated":
            self = .summaryUpdated(
                workspace: try c.decode(String.self, forKey: .workspace),
                summaryID: try c.decode(Int64.self, forKey: .summaryID),
                scopeType: try c.decode(String.self, forKey: .scopeType),
                scopeID: try c.decode(Int64.self, forKey: .scopeID))
        case "task_updated":
            self = .taskUpdated(
                workspace: try c.decode(String.self, forKey: .workspace),
                taskID: try c.decode(Int64.self, forKey: .taskID),
                status: try c.decode(String.self, forKey: .status))
        case "workspace_renamed":
            self = .workspaceRenamed(
                oldName: try c.decode(String.self, forKey: .oldName),
                newName: try c.decode(String.self, forKey: .newName))
        case "chat_thread_renamed":
            self = .chatThreadRenamed(
                threadID: try c.decode(Int64.self, forKey: .threadID),
                title: try c.decode(String.self, forKey: .title))
        case "inventory_changed":
            self = .inventoryChanged(
                scope: try c.decode(String.self, forKey: .scope),
                workspace: try c.decodeIfPresent(String.self, forKey: .workspace),
                repository: try c.decodeIfPresent(String.self, forKey: .repository))
        case let other:
            self = .unknown(type: other)
        }
    }
}

public struct EventEnvelope: Decodable, Sendable {
    public let id: String
    public let payload: ArchcarEvent
}
