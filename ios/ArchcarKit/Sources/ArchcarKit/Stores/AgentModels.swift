import Foundation

/// Model and effort choices per provider.
///
/// There is no enumeration RPC — the daemon accepts whatever string it is
/// given — so this mirrors `desktop/src/lib/models.ts`. A test reads that file
/// and fails if the two drift, because a phone offering a model the desktop
/// dropped would send `set_session_model` with a value the provider rejects.
public enum AgentModels {
    // generated from model-corpus.json by scripts/generate-model-corpus.mjs (models)
    public static let models: [String: [String]] = [
        "codex": [
            "gpt-6.1-sol",
            "gpt-6.1-terra",
            "gpt-6-astra",
            "gpt-6-luna",
        ],
        "claude": [
            "claude-fable-5-1",
            "claude-fable-5",
            "claude-opus-5-5",
            "claude-opus-5",
            "claude-opus-4-8[1m]",
            "claude-opus-4-7[1m]",
            "claude-opus-4-6[1m]",
            "claude-sonnet-5-5",
            "claude-sonnet-5",
            "claude-sonnet-4-6[1m]",
            "claude-sonnet-4-6",
            "claude-haiku-5-5",
            "claude-haiku-4-5",
        ],
        "shell": [],
    ]
    // end generated from model-corpus.json (models)

    public static let efforts = ["low", "medium", "high"]

    public static func models(for provider: String) -> [String] {
        models[provider] ?? []
    }

    /// Human label, matching the desktop's `modelLabel`.
    public static func label(_ model: String) -> String {
        switch model {
        // generated from model-corpus.json by scripts/generate-model-corpus.mjs (labels)
        case "claude-fable-5-1": return "Claude Fable 5.1"
        case "claude-opus-5-5": return "Claude Opus 5.5"
        case "claude-opus-4-8[1m]": return "Claude Opus 4.8 1M"
        case "claude-opus-4-7[1m]": return "Claude Opus 4.7 1M"
        case "claude-opus-4-6[1m]": return "Claude Opus 4.6 1M"
        case "claude-sonnet-5-5": return "Claude Sonnet 5.5"
        case "claude-sonnet-5": return "Claude Sonnet 5 1M"
        case "claude-sonnet-4-6[1m]": return "Claude Sonnet 4.6 1M"
        case "claude-sonnet-4-6": return "Claude Sonnet 4.6"
        case "claude-haiku-5-5": return "Claude Haiku 5.5"
        case "claude-haiku-4-5": return "Claude Haiku 4.5"
        // end generated from model-corpus.json (labels)
        default:
            let longContext = model.hasSuffix("[1m]")
            let base = longContext ? String(model.dropLast(4)) : model
            var parts = base.split(whereSeparator: { $0 == "-" || $0 == "_" })
                .map { part -> String in
                    part.lowercased() == "gpt"
                        ? "GPT" : part.prefix(1).uppercased() + part.dropFirst()
                }
            if longContext { parts.append("1M") }
            return parts.joined(separator: " ")
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
