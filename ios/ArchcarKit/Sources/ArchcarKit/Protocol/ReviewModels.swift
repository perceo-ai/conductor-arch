import Foundation

/// One changed file. Mirrors `DiffFileSummary`.
public struct DiffFileSummary: Decodable, Sendable, Identifiable, Hashable {
    public let path: String
    public let additions: Int?
    public let deletions: Int?
    public let staged: Bool
    public let unstaged: Bool
    public let untracked: Bool

    public var id: String { path }

    /// Last path component, for a phone-width row.
    public var fileName: String { path.split(separator: "/").last.map(String.init) ?? path }
    public var directory: String {
        let parts = path.split(separator: "/").dropLast()
        return parts.isEmpty ? "" : parts.joined(separator: "/")
    }

    /// Single-letter state, the same vocabulary git uses.
    public var stateLabel: String {
        if untracked { return "U" }
        if staged && unstaged { return "MM" }
        if staged { return "M" }
        return "M"
    }
}

/// Mirrors `Todo`.
public struct Todo: Decodable, Sendable, Identifiable, Hashable {
    public let id: Int64
    public let text: String
    public let status: String
    public let source: String
    public let createdAt: String

    public var isOpen: Bool { status != "done" && status != "closed" }

    private enum CodingKeys: String, CodingKey {
        case id, text, status, source
        case createdAt = "created_at"
    }
}

/// Mirrors `ArchcarChecksSummary` — the numbers behind the review panel.
public struct ChecksSummary: Decodable, Sendable, Hashable {
    public let workspace: String
    public let changedFiles: Int
    public let runStatus: String?
    public let checkStatus: String?
    public let checkExitCode: Int?
    public let activeSessions: Int
    public let openTodos: Int
    public let totalTodos: Int
    public let openReviewComments: Int
    public let branchAhead: Int?
    public let branchBehind: Int?
    public let pullRequestNumber: Int64?

    private enum CodingKeys: String, CodingKey {
        case workspace
        case changedFiles = "changed_files"
        case runStatus = "run_status"
        case checkStatus = "check_status"
        case checkExitCode = "check_exit_code"
        case activeSessions = "active_sessions"
        case openTodos = "open_todos"
        case totalTodos = "total_todos"
        case openReviewComments = "open_review_comments"
        case branchAhead = "branch_ahead"
        case branchBehind = "branch_behind"
        case pullRequestNumber = "pull_request_number"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspace = try c.decode(String.self, forKey: .workspace)
        changedFiles = try c.decode(Int.self, forKey: .changedFiles)
        runStatus = try c.decodeIfPresent(String.self, forKey: .runStatus)
        checkStatus = try c.decodeIfPresent(String.self, forKey: .checkStatus)
        checkExitCode = try c.decodeIfPresent(Int.self, forKey: .checkExitCode)
        activeSessions = try c.decodeIfPresent(Int.self, forKey: .activeSessions) ?? 0
        openTodos = try c.decodeIfPresent(Int.self, forKey: .openTodos) ?? 0
        totalTodos = try c.decodeIfPresent(Int.self, forKey: .totalTodos) ?? 0
        openReviewComments = try c.decodeIfPresent(Int.self, forKey: .openReviewComments) ?? 0
        branchAhead = try c.decodeIfPresent(Int.self, forKey: .branchAhead)
        branchBehind = try c.decodeIfPresent(Int.self, forKey: .branchBehind)
        pullRequestNumber = try c.decodeIfPresent(Int64.self, forKey: .pullRequestNumber)
    }
}

/// One GitHub Actions run. Mirrors `WorkflowRun`.
public struct WorkflowRun: Decodable, Sendable, Identifiable, Hashable {
    public let name: String
    /// `completed`, `in_progress`, `queued`, …
    public let status: String
    /// `success`, `failure`, `cancelled`, `skipped`, or empty while running.
    public let conclusion: String
    public let branch: String
    public let url: String
    public let startedAt: String
    public let number: Int64

    public var id: Int64 { number }
    public var isFailure: Bool { conclusion == "failure" || conclusion == "timed_out" }
    public var isRunning: Bool { status != "completed" }

    private enum CodingKeys: String, CodingKey {
        case name, status, conclusion, branch, url, number
        case startedAt = "started_at"
    }
}

/// Mirrors `WorkflowRunSummary`.
public struct WorkflowRunSummary: Decodable, Sendable, Hashable {
    public let runs: [WorkflowRun]
    public let failing: Int
    public let running: Int
    public let succeeded: Int
    /// Set when `gh` could not answer — no auth, no GitHub remote, not
    /// installed. Worth showing verbatim: on a phone the cause is always on the
    /// other machine.
    public let unavailable: String?
}
