import Foundation

/// What kind of turn an input is. Mirrors `ArchcarInputKind`.
public struct ArchcarInputKind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let user = ArchcarInputKind(rawValue: "user")
    public static let reviewPrompt = ArchcarInputKind(rawValue: "review_prompt")
    public static let controlCommand = ArchcarInputKind(rawValue: "control_command")
    public static let rawTerminal = ArchcarInputKind(rawValue: "raw_terminal")

    public init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Mirrors `ArchcarChatThread`.
public struct ChatThread: Decodable, Sendable, Identifiable, Hashable {
    public let id: Int64
    public let provider: String
    public let title: String
    public let status: String
    public let model: String?
    public let effortMode: String?
    public let fastMode: Bool
    public let updatedAt: String
    public let archivedAt: String?

    public var isArchived: Bool { archivedAt != nil }
    /// The provider name doubles as the session kind the daemon expects.
    public var sessionKind: SessionKind { SessionKind(rawValue: provider) }

    private enum CodingKeys: String, CodingKey {
        case id, provider, title, status, model
        case effortMode = "effort_mode"
        case fastMode = "fast_mode"
        case updatedAt = "updated_at"
        case archivedAt = "archived_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int64.self, forKey: .id)
        provider = try container.decode(String.self, forKey: .provider)
        title = try container.decode(String.self, forKey: .title)
        status = try container.decode(String.self, forKey: .status)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        effortMode = try container.decodeIfPresent(String.self, forKey: .effortMode)
        fastMode = try container.decodeIfPresent(Bool.self, forKey: .fastMode) ?? false
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
        archivedAt = try container.decodeIfPresent(String.self, forKey: .archivedAt)
    }
}

/// One rendered timeline row. Mirrors `ArchcarProjectionItem`.
///
/// The heavy projection and dedup work stays in core, so this is deliberately
/// flat: the app decides how a `render_class` looks, never what it means.
public struct ProjectionItem: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let sequence: UInt64
    public let renderClass: String
    public let roleLabel: String
    public let title: String
    public let body: String
    public let status: String
    public let streamState: String
    public let timelineSeq: Int64?

    /// Still being written by the agent, so the view keeps it pinned and shows
    /// a cursor rather than treating it as settled text.
    public var isStreaming: Bool { streamState == "streaming" }

    private enum CodingKeys: String, CodingKey {
        case id, sequence, title, body, status
        case renderClass = "render_class"
        case roleLabel = "role_label"
        case streamState = "stream_state"
        case timelineSeq = "timeline_seq"
    }
}

/// Mirrors `QueuedArchcarInput`.
public struct QueuedChatInput: Decodable, Sendable, Identifiable, Hashable {
    public let id: Int64
    public let threadID: Int64
    public let input: String
    public let visibleInput: String?
    public let kind: ArchcarInputKind
    public let sessionKind: SessionKind
    public let createdAt: String
    public let updatedAt: String

    /// What to show: the daemon keeps the expanded text separately from what
    /// the user typed, and the typed version is the honest one to display.
    public var displayText: String { visibleInput ?? input }

    private enum CodingKeys: String, CodingKey {
        case id, input, kind
        case threadID = "thread_id"
        case visibleInput = "visible_input"
        case sessionKind = "session_kind"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

/// Mirrors `AgentSessionState`.
public enum AgentSessionState: String, Decodable, Sendable {
    case starting
    case running
    case streaming
    case waitingForInput = "waiting_for_input"
    case toolRunning = "tool_running"
    case interrupted
    case failed
    case exited
    case archived
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentSessionState(rawValue: raw) ?? .unknown
    }

    /// Whether a turn is in flight, which is what decides between showing a
    /// send button and showing a stop button.
    public var isBusy: Bool {
        switch self {
        case .running, .streaming, .toolRunning, .starting: true
        case .waitingForInput, .interrupted, .failed, .exited, .archived, .unknown: false
        }
    }
}

public struct SessionStatus: Decodable, Sendable, Hashable {
    public let sessionID: Int64
    public let status: String
    public let runtimeState: AgentSessionState
    public let ready: Bool
    /// Pending questions or permission prompts on this session's thread.
    /// `ready == false` alone reads as "busy"; when the reason is a human, that
    /// is a different instruction to whoever is watching.
    public let pendingInteractions: Int

    private enum CodingKeys: String, CodingKey {
        case status, ready
        case sessionID = "session_id"
        case runtimeState = "runtime_state"
        case pendingInteractions = "pending_interactions"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionID = try container.decode(Int64.self, forKey: .sessionID)
        status = try container.decode(String.self, forKey: .status)
        runtimeState = try container.decode(AgentSessionState.self, forKey: .runtimeState)
        ready = try container.decode(Bool.self, forKey: .ready)
        pendingInteractions = try container.decodeIfPresent(Int.self, forKey: .pendingInteractions) ?? 0
    }
}

// --- Provider interactions -------------------------------------------------

public enum InteractionKind: String, Decodable, Sendable {
    case permission
    case userQuestion = "user_question"
    case planApproval = "plan_approval"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = InteractionKind(rawValue: raw) ?? .unknown
    }
}

public struct InteractionOption: Decodable, Sendable, Hashable {
    public let label: String
    public let description: String
}

public struct InteractionQuestion: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let header: String
    public let question: String
    public let options: [InteractionOption]
    /// The asker accepts free text beyond the listed options.
    public let allowOther: Bool
    /// More than one option may be chosen.
    public let multiSelect: Bool

    private enum CodingKeys: String, CodingKey {
        case id, header, question, options
        case allowOther = "allow_other"
        case multiSelect = "multi_select"
    }
}

public struct InteractionAnswer: Encodable, Sendable, Hashable {
    public let questionID: String
    public let values: [String]

    public init(questionID: String, values: [String]) {
        self.questionID = questionID
        self.values = values
    }

    private enum CodingKeys: String, CodingKey {
        case values
        case questionID = "question_id"
    }
}

/// Mirrors `ProviderInteractionResolution`, which is internally tagged.
public enum InteractionResolution: Encodable, Sendable, Equatable {
    case approve
    case approveForSession
    case deny(reason: String?)
    case answer(answers: [InteractionAnswer])
    case defer_

    private enum CodingKeys: String, CodingKey { case type, reason, answers }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .approve:
            try container.encode("approve", forKey: .type)
        case .approveForSession:
            try container.encode("approve_for_session", forKey: .type)
        case .deny(let reason):
            try container.encode("deny", forKey: .type)
            try container.encode(reason, forKey: .reason)
        case .answer(let answers):
            try container.encode("answer", forKey: .type)
            try container.encode(answers, forKey: .answers)
        case .defer_:
            try container.encode("defer", forKey: .type)
        }
    }
}

/// Mirrors `ProviderInteractionRecord`. This is the record behind a blocked
/// agent — the case a phone exists for.
public struct ProviderInteraction: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public let providerKey: String
    public let workspace: String
    public let threadID: Int64
    public let sessionID: Int64
    public let kind: InteractionKind
    public let title: String
    public let detail: String
    public let questions: [InteractionQuestion]
    public let planPath: String?
    public let status: String
    public let createdAt: String

    public var isPending: Bool { status == "pending" }

    private enum CodingKeys: String, CodingKey {
        case id, workspace, kind, title, detail, questions, status
        case providerKey = "provider_key"
        case threadID = "thread_id"
        case sessionID = "session_id"
        case planPath = "plan_path"
        case createdAt = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        providerKey = try container.decode(String.self, forKey: .providerKey)
        workspace = try container.decode(String.self, forKey: .workspace)
        threadID = try container.decode(Int64.self, forKey: .threadID)
        sessionID = try container.decode(Int64.self, forKey: .sessionID)
        kind = try container.decode(InteractionKind.self, forKey: .kind)
        title = try container.decode(String.self, forKey: .title)
        detail = try container.decode(String.self, forKey: .detail)
        questions = try container.decodeIfPresent([InteractionQuestion].self, forKey: .questions) ?? []
        planPath = try container.decodeIfPresent(String.self, forKey: .planPath)
        status = try container.decode(String.self, forKey: .status)
        createdAt = try container.decode(String.self, forKey: .createdAt)
    }
}
