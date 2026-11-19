import Foundation

/// What a queue item is about. The daemon may be newer than the app, so a kind
/// this build has never heard of decodes to `.unknown` rather than failing the
/// whole queue.
public enum AttentionKind: Equatable, Sendable, Decodable {
    case agentAsked, sessionFailed, stalled, taskFinished
    case checksFailed, reviewComments, diffReady, idle
    case unknown(String)

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        switch raw {
        case "agent_asked": self = .agentAsked
        case "session_failed": self = .sessionFailed
        case "stalled": self = .stalled
        case "task_finished": self = .taskFinished
        case "checks_failed": self = .checksFailed
        case "review_comments": self = .reviewComments
        case "diff_ready": self = .diffReady
        case "idle": self = .idle
        default: self = .unknown(raw)
        }
    }
}

public struct AttentionItem: Decodable, Equatable, Sendable {
    public let kind: AttentionKind
    /// The repository name when a background task has no workspace; `detail`
    /// says so. Check it against the known list before navigating to it.
    public let workspace: String
    public let repository: String
    public let threadID: Int64?
    public let sessionID: Int64?
    public let headline: String
    public let detail: String?
    public let rank: Int

    public init(
        kind: AttentionKind, workspace: String, repository: String, threadID: Int64?,
        sessionID: Int64?, headline: String, detail: String?, rank: Int
    ) {
        self.kind = kind
        self.workspace = workspace
        self.repository = repository
        self.threadID = threadID
        self.sessionID = sessionID
        self.headline = headline
        self.detail = detail
        self.rank = rank
    }

    private enum CodingKeys: String, CodingKey {
        case kind, workspace, repository, headline, detail, rank
        case threadID = "thread_id"
        case sessionID = "session_id"
    }
}

/// Already ranked and totally ordered by the daemon. Render it as given.
public struct AttentionQueue: Decodable, Equatable, Sendable {
    /// RFC3339, unlike the epoch-second strings elsewhere in this protocol.
    public let generatedAt: String
    public let items: [AttentionItem]

    public init(generatedAt: String, items: [AttentionItem]) {
        self.generatedAt = generatedAt
        self.items = items
    }

    private enum CodingKeys: String, CodingKey {
        case generatedAt = "generated_at"
        case items
    }

    public var generatedDate: Date? {
        ISO8601DateFormatter().date(from: generatedAt)
    }
}

/// The urgency tiers every client shares: rank 0-1, 2-4, 5+. Matches `toneOf`
/// in the desktop's Attention page; do not invent another grouping.
public enum AttentionTier: Equatable, Sendable {
    case needsYouNow, worthALook, whenYouHaveAMoment

    public static func of(rank: Int) -> AttentionTier {
        if rank <= 1 { return .needsYouNow }
        if rank <= 4 { return .worthALook }
        return .whenYouHaveAMoment
    }

    public var title: String {
        switch self {
        case .needsYouNow: "Needs you now"
        case .worthALook: "Worth a look"
        case .whenYouHaveAMoment: "When you have a moment"
        }
    }

    public struct Section: Equatable, Sendable {
        public let tier: AttentionTier
        public var items: [AttentionItem]
    }

    /// Contiguous runs of the daemon's order; nothing is re-sorted.
    public static func sections(of items: [AttentionItem]) -> [Section] {
        var out: [Section] = []
        for item in items {
            let tier = of(rank: item.rank)
            if let last = out.last, last.tier == tier {
                out[out.count - 1].items.append(item)
            } else {
                out.append(Section(tier: tier, items: [item]))
            }
        }
        return out
    }
}
