import Foundation

/// Render-time cleanup of agent text.
///
/// Archductor injects blocks into prompts and responses for its own use — the
/// summary/naming metadata, hidden instructions, attachment references. They
/// are part of the transcript but not part of the conversation, and core keeps
/// them in the projection body, so every surface strips them at render time.
/// This is a port of `desktop/src/lib/chatFormat.ts`, which in turn ports
/// core's `strip_archductor_metadata_block`; a surface that skips it shows the
/// user a JSON blob above every reply.
public enum ChatFormat {
    private static let blockTags = ["archductor_metadata", "archductor_hidden_instruction"]

    /// Prose classes, rendered as text.
    private static let textClasses: Set<String> = ["user_chat", "assistant_chat", "reasoning_card"]

    /// Inline activity classes and the verb to use when the title carries no
    /// action word of its own.
    private static let defaultVerb: [String: String] = [
        "command_card": "Ran",
        "process_card": "Ran",
        "background_card": "Ran",
        "error_card": "Error",
        "file_card": "Read",
        "diff_card": "Edited",
        "skill_card": "Used",
        "tool_card": "Used",
        "plugin_card": "Used",
        "subagent_card": "Used",
        "nested_transcript_card": "Used"
    ]

    private static let actionPrefixes: Set<String> = [
        "Ran", "Read", "Used", "Opened", "Added", "Edited", "Deleted", "Searched"
    ]

    /// Assistant prose renders only once finalized: partial markdown churns
    /// while it streams. Activity cards render live so the agent's current
    /// state is visible.
    private static let textFinalizedOnly: Set<String> = ["assistant_chat"]

    /// A strict allowlist, ported from the desktop's `isRenderableClass`.
    /// Anything else — hook cards, mcp chatter, classes core adds later — is
    /// dropped rather than shown as a raw event. A Claude session emits six
    /// hook cards at startup, which on a phone would be the whole first screen.
    public static func isRenderable(renderClass: String) -> Bool {
        textClasses.contains(renderClass) || defaultVerb[renderClass] != nil
    }

    public static func isDisplayable(_ item: ProjectionItem) -> Bool {
        guard isRenderable(renderClass: item.renderClass) else { return false }
        if textFinalizedOnly.contains(item.renderClass) { return item.streamState == "complete" }
        return true
    }

    /// Splits an activity card's title into an action verb and a content chip,
    /// so "Ran cargo test" reads as a verb plus what it acted on instead of
    /// doubling the verb up.
    public static func verbChip(renderClass: String, title: String) -> (verb: String, chip: String) {
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        let first = trimmed.split(separator: " ", maxSplits: 1).first.map(String.init) ?? trimmed
        if actionPrefixes.contains(first) {
            let rest = trimmed.dropFirst(first.count).trimmingCharacters(in: .whitespaces)
            return (first, rest)
        }
        return (defaultVerb[renderClass] ?? "Used", trimmed)
    }

    public static func displayText(_ text: String) -> String {
        var out = text
        for tag in blockTags {
            out = out.replacingOccurrences(
                of: "<\(tag)>[\\s\\S]*?</\(tag)>", with: "", options: .regularExpression)
        }
        // Self-closing attachment references.
        out = out.replacingOccurrences(
            of: "<archductor_attachment\\b[^>]*/>", with: "", options: .regularExpression)
        return out
            .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
