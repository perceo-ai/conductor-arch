import Foundation

// Repository and workspace lifecycle, plus the review surface. These are the
// same RPCs the desktop uses; nothing here is phone-specific.

public struct AddRepositoryRequest: ArchcarRequestBody {
    public static let typeName = "add_repository"
    public let path: String
    public let name: String?
    public let defaultBranch: String?
    public let workspaceParent: String?

    public init(path: String, name: String? = nil, defaultBranch: String? = nil,
                workspaceParent: String? = nil) {
        self.path = path
        self.name = name
        self.defaultBranch = defaultBranch
        self.workspaceParent = workspaceParent
    }

    private enum CodingKeys: String, CodingKey {
        case path, name
        case defaultBranch = "default_branch"
        case workspaceParent = "workspace_parent"
    }
}

public struct CloneRepositoryRequest: ArchcarRequestBody {
    public static let typeName = "clone_repository"
    public let url: String
    public let dest: String
    public let name: String?

    public init(url: String, dest: String, name: String? = nil) {
        self.url = url
        self.dest = dest
        self.name = name
    }
}

public struct CreateWorkspaceRequest: ArchcarRequestBody {
    public static let typeName = "create_workspace"
    public let repository: String
    public let name: String
    public let branch: String
    public let baseRef: String?

    public init(repository: String, name: String, branch: String, baseRef: String? = nil) {
        self.repository = repository
        self.name = name
        self.branch = branch
        self.baseRef = baseRef
    }

    private enum CodingKeys: String, CodingKey {
        case repository, name, branch
        case baseRef = "base_ref"
    }
}

/// Describe the task and let the daemon name the workspace and branch from it.
public struct CreateWorkspaceFromPromptRequest: ArchcarRequestBody {
    public static let typeName = "create_workspace_from_prompt"
    public let repository: String
    public let prompt: String
    public let name: String?
    public let branch: String?
    public let baseRef: String?

    public init(repository: String, prompt: String, name: String? = nil,
                branch: String? = nil, baseRef: String? = nil) {
        self.repository = repository
        self.prompt = prompt
        self.name = name
        self.branch = branch
        self.baseRef = baseRef
    }

    private enum CodingKeys: String, CodingKey {
        case repository, prompt, name, branch
        case baseRef = "base_ref"
    }
}

public struct CreateWorkspaceFromIssueRequest: ArchcarRequestBody {
    public static let typeName = "create_workspace_from_issue"
    public let repository: String
    public let issueNumber: Int
    public let branchPrefix: String?

    public init(repository: String, issueNumber: Int, branchPrefix: String? = nil) {
        self.repository = repository
        self.issueNumber = issueNumber
        self.branchPrefix = branchPrefix
    }

    private enum CodingKeys: String, CodingKey {
        case repository
        case issueNumber = "issue_number"
        case branchPrefix = "branch_prefix"
    }
}

public struct CreateWorkspaceFromPullRequestRequest: ArchcarRequestBody {
    public static let typeName = "create_workspace_from_pull_request"
    public let repository: String
    public let prNumber: Int

    public init(repository: String, prNumber: Int) {
        self.repository = repository
        self.prNumber = prNumber
    }

    private enum CodingKeys: String, CodingKey {
        case repository
        case prNumber = "pr_number"
    }
}

public struct CreateWorkspaceFromLinearRequest: ArchcarRequestBody {
    public static let typeName = "create_workspace_from_linear"
    public let repository: String
    public let issueID: String

    public init(repository: String, issueID: String) {
        self.repository = repository
        self.issueID = issueID
    }

    private enum CodingKeys: String, CodingKey {
        case repository
        case issueID = "issue_id"
    }
}

public struct ArchiveWorkspaceRequest: ArchcarRequestBody {
    public static let typeName = "archive_workspace"
    public let workspace: String
    /// Delete the worktree from disk as well as marking it archived.
    public let removeWorktree: Bool

    public init(workspace: String, removeWorktree: Bool = false) {
        self.workspace = workspace
        self.removeWorktree = removeWorktree
    }

    private enum CodingKeys: String, CodingKey {
        case workspace
        case removeWorktree = "remove_worktree"
    }
}

public struct RestoreWorkspaceRequest: ArchcarRequestBody {
    public static let typeName = "restore_workspace"
    public let workspace: String
    public init(workspace: String) { self.workspace = workspace }
}

public struct RenameWorkspaceRequest: ArchcarRequestBody {
    public static let typeName = "rename_workspace"
    public let workspace: String
    public let name: String

    public init(workspace: String, name: String) {
        self.workspace = workspace
        self.name = name
    }
}

// --- Review ----------------------------------------------------------------

/// Which set of changes a query covers. Mirrors `WorkspaceChangeScope`.
///
/// Externally tagged, which is serde's default and *not* the `{"type": …}`
/// shape the rest of this protocol uses: the unit cases are bare strings and
/// the commit case nests its payload under the variant name. Sending the wrong
/// shape makes the daemon drop the connection without answering, because a
/// request that fails to deserialize never reaches a handler that could reply.
public enum WorkspaceChangeScope: Encodable, Sendable, Equatable, Hashable {
    case all
    case uncommitted
    case commit(sha: String)

    private enum CodingKeys: String, CodingKey { case commit }
    private enum CommitKeys: String, CodingKey { case sha }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .all:
            var container = encoder.singleValueContainer()
            try container.encode("all")
        case .uncommitted:
            var container = encoder.singleValueContainer()
            try container.encode("uncommitted")
        case .commit(let sha):
            var container = encoder.container(keyedBy: CodingKeys.self)
            var commit = container.nestedContainer(keyedBy: CommitKeys.self, forKey: .commit)
            try commit.encode(sha, forKey: .sha)
        }
    }

    public var label: String {
        switch self {
        case .all: "All changes"
        case .uncommitted: "Uncommitted"
        case .commit(let sha): "Commit \(sha.prefix(7))"
        }
    }
}

public struct GetWorkspaceChangesRequest: ArchcarRequestBody {
    public static let typeName = "get_workspace_changes"
    public let workspace: String
    public let scope: WorkspaceChangeScope

    public init(workspace: String, scope: WorkspaceChangeScope = .all) {
        self.workspace = workspace
        self.scope = scope
    }
}

public struct GetWorkspaceDiffRequest: ArchcarRequestBody {
    public static let typeName = "get_workspace_diff"
    public let workspace: String
    public let path: String?
    public let scope: WorkspaceChangeScope

    public init(workspace: String, path: String? = nil, scope: WorkspaceChangeScope = .all) {
        self.workspace = workspace
        self.path = path
        self.scope = scope
    }
}

public struct GetChecksSummaryRequest: ArchcarRequestBody {
    public static let typeName = "get_checks_summary"
    public let workspace: String
    public init(workspace: String) { self.workspace = workspace }
}

public struct ListWorkflowRunsRequest: ArchcarRequestBody {
    public static let typeName = "list_workflow_runs"
    public let workspace: String
    public init(workspace: String) { self.workspace = workspace }
}

public struct ListTodosRequest: ArchcarRequestBody {
    public static let typeName = "list_todos"
    public let workspace: String
    public init(workspace: String) { self.workspace = workspace }
}

public struct AddTodoRequest: ArchcarRequestBody {
    public static let typeName = "add_todo"
    public let workspace: String
    public let text: String

    public init(workspace: String, text: String) {
        self.workspace = workspace
        self.text = text
    }
}

public struct GetPullRequestReadinessRequest: ArchcarRequestBody {
    public static let typeName = "get_pull_request_readiness"
    public let workspace: String
    public init(workspace: String) { self.workspace = workspace }
}

/// The PR actions the daemon runs through `gh`. Each is its own RPC rather
/// than one action enum, matching the daemon.
public struct PushBranchRequest: ArchcarRequestBody {
    public static let typeName = "push_branch"
    public let workspace: String
    /// `--force-with-lease` rather than a plain push.
    public let force: Bool

    public init(workspace: String, force: Bool = false) {
        self.workspace = workspace
        self.force = force
    }
}

public struct CreatePullRequestRequest: ArchcarRequestBody {
    public static let typeName = "create_pull_request"
    public let workspace: String
    public let title: String?
    public let body: String?
    public let draft: Bool

    public init(workspace: String, title: String? = nil, body: String? = nil, draft: Bool = false) {
        self.workspace = workspace
        self.title = title
        self.body = body
        self.draft = draft
    }
}

/// The daemon drafts a title and body from the workspace's summary, tasks, and
/// agent contributions — worth showing before creating a PR from a phone,
/// where nobody wants to type one.
public struct GetPullRequestDraftRequest: ArchcarRequestBody {
    public static let typeName = "get_pull_request_draft"
    public let workspace: String
    public init(workspace: String) { self.workspace = workspace }
}

public struct RefreshPullRequestRequest: ArchcarRequestBody {
    public static let typeName = "refresh_pull_request"
    public let workspace: String
    public init(workspace: String) { self.workspace = workspace }
}

public struct MergePullRequestRequest: ArchcarRequestBody {
    public static let typeName = "merge_pull_request"
    public let workspace: String
    /// `squash`, `merge`, or `rebase`; the daemon picks a default when absent.
    public let method: String?

    public init(workspace: String, method: String? = nil) {
        self.workspace = workspace
        self.method = method
    }
}

public struct CommitWorkspaceChangesRequest: ArchcarRequestBody {
    public static let typeName = "commit_workspace_changes"
    public let workspace: String
    public let message: String
    public let stageAll: Bool

    public init(workspace: String, message: String, stageAll: Bool = true) {
        self.workspace = workspace
        self.message = message
        self.stageAll = stageAll
    }

    private enum CodingKeys: String, CodingKey {
        case workspace, message
        case stageAll = "stage_all"
    }
}
