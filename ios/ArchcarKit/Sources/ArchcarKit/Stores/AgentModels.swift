import Foundation

/// Model and effort choices per provider.
///
/// There is no enumeration RPC — the daemon accepts whatever string it is
/// given — so this mirrors `desktop/src/lib/models.ts`. A test reads that file
/// and fails if the two drift, because a phone offering a model the desktop
/// dropped would send `set_session_model` with a value the provider rejects.
public enum AgentModels {
    public static let models: [String: [String]] = [
        "codex": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
        "claude": [
            "claude-fable-5",
            "claude-opus-5",
            "claude-opus-4-8[1m]",
            "claude-opus-4-7[1m]",
            "claude-opus-4-6[1m]",
            "claude-sonnet-5",
            "claude-sonnet-4-6[1m]",
            "claude-sonnet-4-6",
            "claude-haiku-4-5"
        ],
        "shell": []
    ]

    public static let efforts = ["low", "medium", "high"]

    public static func models(for provider: String) -> [String] {
        models[provider] ?? []
    }

    /// Human label, matching the desktop's `modelLabel`.
    public static func label(_ model: String) -> String {
        switch model {
        case "gpt-5.6-sol": return "GPT 5.6 Sol"
        case "gpt-5.6-terra": return "GPT 5.6 Terra"
        case "gpt-5.6-luna": return "GPT 5.6 Luna"
        case "gpt-5.5": return "GPT 5.5"
        case "gpt-5.4": return "GPT 5.4"
        case "claude-opus-4-8[1m]": return "Claude Opus 4.8 1M"
        case "claude-opus-4-7[1m]": return "Claude Opus 4.7 1M"
        case "claude-opus-4-6[1m]": return "Claude Opus 4.6 1M"
        case "claude-sonnet-5": return "Claude Sonnet 5 1M"
        case "claude-sonnet-4-6[1m]": return "Claude Sonnet 4.6 1M"
        case "claude-sonnet-4-6": return "Claude Sonnet 4.6"
        case "claude-haiku-4-5": return "Claude Haiku 4.5"
        default:
            return model
                .split(separator: "-")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }
}

/// One agent the daemon can drive. Mirrors `AgentProviderSummary`.
public struct AgentProvider: Decodable, Sendable, Identifiable, Hashable {
    public let providerKey: String
    public let displayName: String
    /// Offered as a chat provider in pickers.
    public let launchable: Bool
    /// Driven through a managed harness rather than a bare PTY.
    public let managed: Bool
    /// `full`, `partial`, `basic`, or `none` when unmanaged.
    public let tier: String
    public let authGuidance: String

    public var id: String { providerKey }

    public init(
        providerKey: String, displayName: String, launchable: Bool, managed: Bool,
        tier: String, authGuidance: String
    ) {
        self.providerKey = providerKey
        self.displayName = displayName
        self.launchable = launchable
        self.managed = managed
        self.tier = tier
        self.authGuidance = authGuidance
    }

    private enum CodingKeys: String, CodingKey {
        case tier
        case providerKey = "provider_key"
        case displayName = "display_name"
        case launchable, managed
        case authGuidance = "auth_guidance"
    }
}

public struct ListAgentProvidersRequest: ArchcarRequestBody {
    public static let typeName = "list_agent_providers"
    public init() {}
}

public struct SetSessionEffortRequest: ArchcarRequestBody {
    public static let typeName = "set_session_effort"
    public let sessionID: Int64
    public let effort: String?

    public init(sessionID: Int64, effort: String?) {
        self.sessionID = sessionID
        self.effort = effort
    }

    private enum CodingKeys: String, CodingKey {
        case effort
        case sessionID = "session_id"
    }
}
