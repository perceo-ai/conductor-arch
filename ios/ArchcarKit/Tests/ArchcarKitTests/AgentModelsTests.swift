import Foundation
import Testing

@testable import ArchcarKit

/// The desktop's table is the source of truth; this reads it so the two
/// surfaces cannot offer different models.
private func desktopModelsFile() throws -> String {
    let repoRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // ArchcarKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // ArchcarKit
        .deletingLastPathComponent()  // ios
        .deletingLastPathComponent()  // repository root
    return try String(
        contentsOf: repoRoot.appendingPathComponent("desktop/src/lib/models.ts"), encoding: .utf8)
}

/// Reads a `name: [ … ]` array out of the TypeScript source.
///
/// Bracket depth matters: model ids like `claude-opus-4-8[1m]` contain a
/// closing bracket, so scanning for the first `]` stops in the middle of the
/// list and silently compares a truncated table.
private func list(named name: String, in source: String) -> [String] {
    guard let start = source.range(of: "\(name): [") else { return [] }
    var depth = 1
    var body = ""
    for character in source[start.upperBound...] {
        if character == "[" { depth += 1 }
        if character == "]" {
            depth -= 1
            if depth == 0 { break }
        }
        body.append(character)
    }
    return quotedStrings(in: body)
}

/// Every double-quoted string in a fragment, in order.
private func quotedStrings(in fragment: String) -> [String] {
    var values: [String] = []
    var current: String?
    for character in fragment {
        if character == "\"" {
            if let value = current {
                values.append(value)
                current = nil
            } else {
                current = ""
            }
            continue
        }
        if current != nil { current?.append(character) }
    }
    return values
}

@Test func modelTableMatchesTheDesktop() throws {
    let source = try desktopModelsFile()
    for provider in ["codex", "claude"] {
        let desktop = list(named: provider, in: source)
        #expect(!desktop.isEmpty, "could not read the desktop table for \(provider)")
        #expect(
            AgentModels.models(for: provider) == desktop,
            "\(provider) models drifted from desktop/src/lib/models.ts")
    }
}

@Test func effortTableMatchesTheDesktop() throws {
    let source = try desktopModelsFile()
    guard let start = source.range(of: "EFFORTS = [") else {
        Issue.record("could not find EFFORTS in the desktop table")
        return
    }
    let rest = source[start.upperBound...]
    let end = try #require(rest.firstIndex(of: "]"))
    #expect(AgentModels.efforts == quotedStrings(in: String(rest[..<end])))
}

@Test func labelsMatchTheDesktopForKnownModels() {
    #expect(AgentModels.label("claude-opus-5") == "Claude Opus 5")
    #expect(AgentModels.label("gpt-5.6-sol") == "GPT 5.6 Sol")
    #expect(AgentModels.label("claude-sonnet-4-6[1m]") == "Claude Sonnet 4.6 1M")
    // Unknown ids are title-cased rather than dropped, so a model the daemon
    // reports but this table has not heard of still renders.
    #expect(AgentModels.label("some-new-model") == "Some New Model")
}

@Test func decodesAgentProviders() throws {
    let json = """
    {"id":"1","payload":{"type":"agent_providers","providers":[{"provider_key":"claude",
    "display_name":"Claude Code","default_command":"claude","launchable":true,"managed":true,
    "tier":"full","auth_guidance":"run claude login"}]}}
    """
    guard case .agentProviders(let providers) = try JSONDecoder()
        .decode(ResponseEnvelope.self, from: Data(json.utf8)).payload else {
        Issue.record("expected agent_providers")
        return
    }
    #expect(providers.first?.displayName == "Claude Code")
    #expect(providers.first?.launchable == true)
}
