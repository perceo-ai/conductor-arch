import Foundation

public struct ListWorkspaceFilesRequest: ArchcarRequestBody {
    public static let typeName = "list_workspace_files"
    public let workspace: String
    public init(workspace: String) { self.workspace = workspace }
}

public struct ReadWorkspaceFileRequest: ArchcarRequestBody {
    public static let typeName = "read_workspace_file"
    public let workspace: String
    public let path: String

    public init(workspace: String, path: String) {
        self.workspace = workspace
        self.path = path
    }
}

public struct WriteWorkspaceFileRequest: ArchcarRequestBody {
    public static let typeName = "write_workspace_file"
    public let workspace: String
    public let path: String
    public let content: String

    public init(workspace: String, path: String, content: String) {
        self.workspace = workspace
        self.path = path
        self.content = content
    }
}

/// Starts a session of a given kind in a workspace — a shell, for the terminal.
public struct SpawnSessionRequest: ArchcarRequestBody {
    public static let typeName = "spawn_session"
    public let workspace: String
    public let kind: SessionKind

    public init(workspace: String, kind: SessionKind) {
        self.workspace = workspace
        self.kind = kind
    }
}

/// The rendered VT100 screen for a session, as text.
public struct GetSessionScreenRequest: ArchcarRequestBody {
    public static let typeName = "get_session_screen"
    public let sessionID: Int64
    public init(sessionID: Int64) { self.sessionID = sessionID }
    private enum CodingKeys: String, CodingKey { case sessionID = "session_id" }
}

/// Keystrokes for a terminal session. `raw_terminal` is what makes a shell
/// treat the bytes as typing rather than as a chat turn.
public struct SendInputRequest: ArchcarRequestBody {
    public static let typeName = "send_input"
    public let sessionID: Int64
    public let input: String
    public let kind: ArchcarInputKind

    public init(sessionID: Int64, input: String, kind: ArchcarInputKind = .rawTerminal) {
        self.sessionID = sessionID
        self.input = input
        self.kind = kind
    }

    private enum CodingKeys: String, CodingKey {
        case input, kind
        case sessionID = "session_id"
    }
}

public struct ResizeSessionRequest: ArchcarRequestBody {
    public static let typeName = "resize_session"
    public let sessionID: Int64
    public let rows: Int
    public let cols: Int

    public init(sessionID: Int64, rows: Int, cols: Int) {
        self.sessionID = sessionID
        self.rows = rows
        self.cols = cols
    }

    private enum CodingKeys: String, CodingKey {
        case rows, cols
        case sessionID = "session_id"
    }
}

/// The daemon's processes report: setups, runs, checks, and sessions, as text.
public struct GetWorkspaceProcessesRequest: ArchcarRequestBody {
    public static let typeName = "get_workspace_processes"
    public let workspace: String
    public init(workspace: String) { self.workspace = workspace }
}

public struct KillSessionRequest: ArchcarRequestBody {
    public static let typeName = "kill_session"
    public let sessionID: Int64
    public init(sessionID: Int64) { self.sessionID = sessionID }
    private enum CodingKeys: String, CodingKey { case sessionID = "session_id" }
}
