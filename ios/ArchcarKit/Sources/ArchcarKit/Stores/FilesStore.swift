import Foundation

/// The workspace's files, browsed and edited from the phone.
@MainActor
@Observable
public final class FilesStore {
    public private(set) var paths: [String] = []
    public private(set) var isLoading = false
    public private(set) var lastError: String?

    private let session: DaemonSession
    public let workspace: String

    public init(session: DaemonSession, workspace: String) {
        self.session = session
        self.workspace = workspace
    }

    /// Paths under a directory prefix, split into subdirectories and files.
    ///
    /// The daemon returns one flat list, so the tree is derived here rather
    /// than asking per level — a phone on a slow link should pay for one round
    /// trip, not one per tap.
    public func entries(under prefix: String) -> (directories: [String], files: [String]) {
        let scoped = prefix.isEmpty ? paths : paths.filter { $0.hasPrefix(prefix + "/") }
        var directories = Set<String>()
        var files: [String] = []
        for path in scoped {
            let remainder = prefix.isEmpty ? path : String(path.dropFirst(prefix.count + 1))
            if let slash = remainder.firstIndex(of: "/") {
                directories.insert(String(remainder[..<slash]))
            } else {
                files.append(remainder)
            }
        }
        return (directories.sorted(), files.sorted())
    }

    public func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await session.request(ListWorkspaceFilesRequest(workspace: workspace))
            guard case .workspaceFiles(_, let files) = response else { return }
            paths = files.sorted()
            lastError = nil
        } catch {
            lastError = String(describing: error)
        }
    }

    public func read(_ path: String) async -> String? {
        do {
            let response = try await session.request(
                ReadWorkspaceFileRequest(workspace: workspace, path: path))
            guard case .workspaceFileContent(_, _, let content) = response else { return nil }
            lastError = nil
            return content
        } catch {
            lastError = String(describing: error)
            return nil
        }
    }

    @discardableResult
    public func write(_ path: String, content: String) async -> Bool {
        do {
            let response = try await session.request(
                WriteWorkspaceFileRequest(workspace: workspace, path: path, content: content))
            guard case .workspaceFileWritten = response else { return false }
            lastError = nil
            return true
        } catch {
            lastError = String(describing: error)
            return false
        }
    }
}
