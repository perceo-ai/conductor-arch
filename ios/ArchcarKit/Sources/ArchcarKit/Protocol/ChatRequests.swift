import Foundation

public struct ListChatThreadsRequest: ArchcarRequestBody {
    public static let typeName = "list_chat_threads"
    public let workspace: String
    public init(workspace: String) { self.workspace = workspace }
}

/// The render-ready timeline. Core does the projection and dedup, so the phone
/// and the desktop draw the same conversation from the same items.
public struct GetChatProjectionRequest: ArchcarRequestBody {
    public static let typeName = "get_chat_projection"
    public let threadID: Int64
    public init(threadID: Int64) { self.threadID = threadID }

    private enum CodingKeys: String, CodingKey { case threadID = "thread_id" }
}

public struct CreateChatThreadRequest: ArchcarRequestBody {
    public static let typeName = "create_chat_thread"
    public let workspace: String
    public let provider: String
    public let title: String

    public init(workspace: String, provider: String, title: String) {
        self.workspace = workspace
        self.provider = provider
        self.title = title
    }
}

/// Starts (or reuses) the agent session behind a chat.
public struct EnsureChatThreadSessionRequest: ArchcarRequestBody {
    public static let typeName = "ensure_chat_thread_session"
    public let workspace: String
    public let threadID: Int64
    public let kind: SessionKind

    public init(workspace: String, threadID: Int64, kind: SessionKind) {
        self.workspace = workspace
        self.threadID = threadID
        self.kind = kind
    }

    private enum CodingKeys: String, CodingKey {
        case workspace, kind
        case threadID = "thread_id"
    }
}

/// Queues a turn. The daemon owns the queue, so the app never keeps one of its
/// own — a phone that queued locally would lose the work when it slept.
public struct QueueChatInputRequest: ArchcarRequestBody {
    public static let typeName = "queue_chat_input"
    public let threadID: Int64
    public let input: String
    public let visibleInput: String?
    public let kind: ArchcarInputKind
    public let sessionKind: SessionKind

    public init(
        threadID: Int64,
        input: String,
        visibleInput: String? = nil,
        kind: ArchcarInputKind = .user,
        sessionKind: SessionKind
    ) {
        self.threadID = threadID
        self.input = input
        self.visibleInput = visibleInput
        self.kind = kind
        self.sessionKind = sessionKind
    }

    private enum CodingKeys: String, CodingKey {
        case input, kind
        case threadID = "thread_id"
        case visibleInput = "visible_input"
        case sessionKind = "session_kind"
    }
}

public struct ListQueuedChatInputsRequest: ArchcarRequestBody {
    public static let typeName = "list_queued_chat_inputs"
    public let threadID: Int64
    public init(threadID: Int64) { self.threadID = threadID }
    private enum CodingKeys: String, CodingKey { case threadID = "thread_id" }
}

public struct RemoveQueuedChatInputRequest: ArchcarRequestBody {
    public static let typeName = "remove_queued_chat_input"
    public let queueID: Int64
    public init(queueID: Int64) { self.queueID = queueID }
    private enum CodingKeys: String, CodingKey { case queueID = "queue_id" }
}

public struct MoveQueuedChatInputRequest: ArchcarRequestBody {
    public static let typeName = "move_queued_chat_input"
    public let queueID: Int64
    /// Toward the front of the queue.
    public let up: Bool

    public init(queueID: Int64, up: Bool) {
        self.queueID = queueID
        self.up = up
    }

    private enum CodingKeys: String, CodingKey {
        case up
        case queueID = "queue_id"
    }
}

public struct InterruptTurnRequest: ArchcarRequestBody {
    public static let typeName = "interrupt_turn"
    public let sessionID: Int64
    public init(sessionID: Int64) { self.sessionID = sessionID }
    private enum CodingKeys: String, CodingKey { case sessionID = "session_id" }
}

public struct GetSessionStatusRequest: ArchcarRequestBody {
    public static let typeName = "get_session_status"
    public let sessionID: Int64
    public init(sessionID: Int64) { self.sessionID = sessionID }
    private enum CodingKeys: String, CodingKey { case sessionID = "session_id" }
}

public struct SetChatPlanModeRequest: ArchcarRequestBody {
    public static let typeName = "set_chat_plan_mode"
    public let threadID: Int64
    public let planMode: Bool

    public init(threadID: Int64, planMode: Bool) {
        self.threadID = threadID
        self.planMode = planMode
    }

    private enum CodingKeys: String, CodingKey {
        case threadID = "thread_id"
        case planMode = "plan_mode"
    }
}

public struct GetChatPlanRequest: ArchcarRequestBody {
    public static let typeName = "get_chat_plan"
    public let threadID: Int64
    public init(threadID: Int64) { self.threadID = threadID }
    private enum CodingKeys: String, CodingKey { case threadID = "thread_id" }
}

public struct SetSessionModelRequest: ArchcarRequestBody {
    public static let typeName = "set_session_model"
    public let sessionID: Int64
    public let model: String?

    public init(sessionID: Int64, model: String?) {
        self.sessionID = sessionID
        self.model = model
    }

    private enum CodingKeys: String, CodingKey {
        case model
        case sessionID = "session_id"
    }
}

public struct SetSessionPermissionModeRequest: ArchcarRequestBody {
    public static let typeName = "set_session_permission_mode"
    public let sessionID: Int64
    public let mode: String

    public init(sessionID: Int64, mode: String) {
        self.sessionID = sessionID
        self.mode = mode
    }

    private enum CodingKeys: String, CodingKey {
        case mode
        case sessionID = "session_id"
    }
}

/// Pending asks from the agent: permission prompts, questions, plan approvals.
public struct ListProviderInteractionsRequest: ArchcarRequestBody {
    public static let typeName = "list_provider_interactions"
    public let threadID: Int64?
    public let pendingOnly: Bool

    public init(threadID: Int64? = nil, pendingOnly: Bool = true) {
        self.threadID = threadID
        self.pendingOnly = pendingOnly
    }

    private enum CodingKeys: String, CodingKey {
        case threadID = "thread_id"
        case pendingOnly = "pending_only"
    }
}

public struct ResolveProviderInteractionRequest: ArchcarRequestBody {
    public static let typeName = "resolve_provider_interaction"
    public let interactionID: String
    public let resolution: InteractionResolution

    public init(interactionID: String, resolution: InteractionResolution) {
        self.interactionID = interactionID
        self.resolution = resolution
    }

    private enum CodingKeys: String, CodingKey {
        case resolution
        case interactionID = "interaction_id"
    }
}
