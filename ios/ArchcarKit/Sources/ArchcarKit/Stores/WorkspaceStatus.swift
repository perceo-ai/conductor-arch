import Foundation

/// The status dot vocabulary, matching the desktop left rail exactly.
///
/// `blocked` outranks everything else on purpose: an agent waiting on a human
/// is burning wall-clock and looks identical to a working one unless it is
/// called out first.
public enum WorkspaceStatusDot: String, Sendable, CaseIterable {
    case blocked
    case running
    case review
    case idle

    public static func dot(for workspace: WorkspaceSummary) -> WorkspaceStatusDot {
        if workspace.awaitingInput || workspace.blockedTasks > 0 { return .blocked }
        if workspace.activeSessions > 0 || workspace.runRunning { return .running }
        if let state = workspace.pullRequestState, state.lowercased() == "open" { return .review }
        return .idle
    }
}
