import Foundation

/// The agents this daemon can launch as chats.
///
/// Read from the daemon rather than hardcoded so a provider added there appears
/// in the picker without an app release. A shell has no turn model, so only
/// launchable managed agents are offered.
public enum AgentProviderCatalog {
    /// Used when the daemon is too old to answer `list_agent_providers`; the
    /// picker stays usable rather than empty.
    public static let fallback: [AgentProvider] = [
        AgentProvider(
            providerKey: "codex", displayName: "Codex", launchable: true, managed: true,
            tier: "full", authGuidance: ""),
        AgentProvider(
            providerKey: "claude", displayName: "Claude Code", launchable: true, managed: true,
            tier: "full", authGuidance: "")
    ]

    public static func launchable(session: DaemonSession) async -> [AgentProvider] {
        let response = try? await session.request(ListAgentProvidersRequest())
        guard case .agentProviders(let providers) = response else { return fallback }
        let usable = providers.filter { $0.launchable && $0.managed }
        return usable.isEmpty ? fallback : usable
    }
}
