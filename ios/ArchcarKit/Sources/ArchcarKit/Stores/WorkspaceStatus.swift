import Foundation

/// The workspace status indicator, ported field-for-field from the desktop's
/// `desktop/src/lib/workspaceStatus.ts`.
///
/// The vocabulary is deliberately identical across surfaces: a workspace that
/// reads "running" on the desktop must not read "blocked" on a phone. Note that
/// `blocked` comes from blocked *tasks*, as it does there — `awaitingInput` is
/// a real and urgent signal, but it is surfaced as its own chip rather than
/// forked into this scale.
public enum WorkspaceStatusKind: String, Sendable, CaseIterable {
    case archived
    case blocked
    case running
    case review
    case changes
    case idle

    /// Precedence: archived first, then a blocked task (it needs a human), then
    /// live work, then an open PR under review, then uncommitted changes, else
    /// idle. First match wins.
    public static func kind(for workspace: WorkspaceSummary) -> WorkspaceStatusKind {
        if workspace.status == "archived" { return .archived }
        if workspace.blockedTasks > 0 { return .blocked }
        if workspace.runRunning || workspace.activeSessions > 0 { return .running }
        if workspace.pullRequestNumber != nil,
           (workspace.pullRequestState ?? "").lowercased() == "open" { return .review }
        if workspace.changedFiles > 0 { return .changes }
        return .idle
    }

    /// The same hex values the desktop uses, so the dots match across surfaces.
    public var colorHex: String {
        switch self {
        case .blocked: "#d97706"   // orange — a task is blocked and needs a human
        case .running: "#3fb27f"   // green — active session / run
        case .review: "#5b8def"    // blue — open PR
        case .changes: "#c39b50"   // amber — uncommitted changes
        case .idle: "#6a6a6a"      // grey — nothing in flight
        case .archived: "#4a4a4a"  // dim — archived
        }
    }

    public var label: String {
        switch self {
        case .blocked: "Blocked"
        case .running: "Running"
        case .review: "In review"
        case .changes: "Has changes"
        case .idle: "Idle"
        case .archived: "Archived"
        }
    }

    public var color: ColorComponents {
        // Every case is a literal hex above, so this cannot fail; the fallback
        // keeps the property non-optional for call sites.
        ColorComponents(css: colorHex) ?? ColorComponents(red: 0.5, green: 0.5, blue: 0.5, alpha: 1)
    }
}

/// Whether anything is live in a workspace, for the row's activity indicator.
/// Ported from `workspaceRowActivity`.
public struct WorkspaceActivity: Sendable, Equatable {
    public let count: Int
    public let title: String

    public static func activity(for workspace: WorkspaceSummary) -> WorkspaceActivity? {
        let agents = workspace.activeSessions
        let run = workspace.runRunning ? 1 : 0
        guard agents + run > 0 else { return nil }

        var parts: [String] = []
        if agents > 0 { parts.append("\(agents) agent session\(agents == 1 ? "" : "s")") }
        if run > 0 { parts.append("run script") }
        return WorkspaceActivity(count: agents + run, title: "\(parts.joined(separator: " and ")) running")
    }
}
