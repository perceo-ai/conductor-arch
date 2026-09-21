import Foundation

/// Which agent runs in a session. Open on the wire (core interns arbitrary
/// strings), so this is a raw-value wrapper rather than a closed enum: a
/// daemon that grows a new provider must not fail to decode here.
public struct SessionKind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let shell = SessionKind(rawValue: "shell")
    public static let codex = SessionKind(rawValue: "codex")
    public static let claude = SessionKind(rawValue: "claude")
    public static let cursor = SessionKind(rawValue: "cursor")

    public init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Mirrors `ArchcarWorkspaceSummary`.
public struct WorkspaceSummary: Decodable, Sendable, Identifiable, Hashable {
    public let id: Int64
    public let name: String
    public let repositoryName: String
    public let path: String
    public let branch: String
    public let baseRef: String
    public let status: String
    public let openTodos: Int
    public let openTasks: Int
    public let blockedTasks: Int
    public let activeSessions: Int
    /// An agent here is blocked on a question or permission prompt. Distinct
    /// from `activeSessions`: it looks identical to a working agent unless it
    /// is called out, and it is the one state a phone exists to surface.
    public let awaitingInput: Bool
    public let runRunning: Bool
    public let changedFiles: Int
    public let diffAdditions: Int
    public let diffDeletions: Int
    public let pullRequestNumber: Int64?
    public let pullRequestState: String?
    public let pullRequestURL: String?
    public let branchAhead: Int?
    public let branchBehind: Int?
    /// Epoch seconds as a string. `Date.parse` on this value returns nothing
    /// useful; format it through `RelativeTime`.
    public let updatedAt: String

    private enum CodingKeys: String, CodingKey {
        case id, name, path, branch, status
        case repositoryName = "repository_name"
        case baseRef = "base_ref"
        case openTodos = "open_todos"
        case openTasks = "open_tasks"
        case blockedTasks = "blocked_tasks"
        case activeSessions = "active_sessions"
        case awaitingInput = "awaiting_input"
        case runRunning = "run_running"
        case changedFiles = "changed_files"
        case diffAdditions = "diff_additions"
        case diffDeletions = "diff_deletions"
        case pullRequestNumber = "pull_request_number"
        case pullRequestState = "pull_request_state"
        case pullRequestURL = "pull_request_url"
        case branchAhead = "branch_ahead"
        case branchBehind = "branch_behind"
        case updatedAt = "updated_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int64.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        repositoryName = try container.decode(String.self, forKey: .repositoryName)
        path = try container.decode(String.self, forKey: .path)
        branch = try container.decode(String.self, forKey: .branch)
        baseRef = try container.decode(String.self, forKey: .baseRef)
        status = try container.decode(String.self, forKey: .status)
        openTodos = try container.decode(Int.self, forKey: .openTodos)
        // `#[serde(default)]` on the Rust side: absent means zero/false.
        openTasks = try container.decodeIfPresent(Int.self, forKey: .openTasks) ?? 0
        blockedTasks = try container.decodeIfPresent(Int.self, forKey: .blockedTasks) ?? 0
        activeSessions = try container.decode(Int.self, forKey: .activeSessions)
        awaitingInput = try container.decodeIfPresent(Bool.self, forKey: .awaitingInput) ?? false
        runRunning = try container.decode(Bool.self, forKey: .runRunning)
        changedFiles = try container.decode(Int.self, forKey: .changedFiles)
        diffAdditions = try container.decode(Int.self, forKey: .diffAdditions)
        diffDeletions = try container.decode(Int.self, forKey: .diffDeletions)
        pullRequestNumber = try container.decodeIfPresent(Int64.self, forKey: .pullRequestNumber)
        pullRequestState = try container.decodeIfPresent(String.self, forKey: .pullRequestState)
        pullRequestURL = try container.decodeIfPresent(String.self, forKey: .pullRequestURL)
        branchAhead = try container.decodeIfPresent(Int.self, forKey: .branchAhead)
        branchBehind = try container.decodeIfPresent(Int.self, forKey: .branchBehind)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }
}

/// Mirrors `ArchcarRepositorySummary`.
public struct RepositorySummary: Decodable, Sendable, Identifiable, Hashable {
    public let id: Int64
    public let name: String
    public let rootPath: String
    public let defaultBranch: String
    public let remoteName: String
    public let remoteURL: String?
    public let activeWorkspaces: Int
    public let totalWorkspaces: Int

    private enum CodingKeys: String, CodingKey {
        case id, name
        case rootPath = "root_path"
        case defaultBranch = "default_branch"
        case remoteName = "remote_name"
        case remoteURL = "remote_url"
        case activeWorkspaces = "active_workspaces"
        case totalWorkspaces = "total_workspaces"
    }
}
