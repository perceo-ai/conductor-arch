import Foundation

/// A unified diff, split into lines a phone can colour.
///
/// The daemon returns raw `git diff` text. Parsing it here rather than in the
/// view keeps the rendering dumb and makes the interesting part — which lines
/// are additions, which are context, where a file starts — testable.
public struct DiffLine: Sendable, Identifiable, Hashable {
    public enum Kind: Sendable, Equatable {
        case fileHeader
        case hunkHeader
        case addition
        case deletion
        case context
    }

    public let id: Int
    public let kind: Kind
    public let text: String
}

public enum DiffParser {
    /// Caps what is parsed. A generated lockfile diff can be megabytes, and a
    /// phone should show the first screenfuls rather than stall.
    public static let lineLimit = 2000

    public static func parse(_ diff: String) -> (lines: [DiffLine], truncated: Bool) {
        var lines: [DiffLine] = []
        var truncated = false
        for (index, raw) in diff.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            if index >= lineLimit {
                truncated = true
                break
            }
            let text = String(raw)
            let kind: DiffLine.Kind
            if text.hasPrefix("diff --git") || text.hasPrefix("index ")
                || text.hasPrefix("--- ") || text.hasPrefix("+++ ")
                || text.hasPrefix("new file") || text.hasPrefix("deleted file") {
                kind = .fileHeader
            } else if text.hasPrefix("@@") {
                kind = .hunkHeader
            } else if text.hasPrefix("+") {
                kind = .addition
            } else if text.hasPrefix("-") {
                kind = .deletion
            } else {
                kind = .context
            }
            lines.append(DiffLine(id: index, kind: kind, text: text))
        }
        return (lines, truncated)
    }
}
