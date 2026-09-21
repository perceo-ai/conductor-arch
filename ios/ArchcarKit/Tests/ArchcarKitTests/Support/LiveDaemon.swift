import Foundation

@testable import ArchcarKit

/// Boots the real `archcar` binary against a throwaway state root.
///
/// Isolation is by environment: archcar resolves everything through
/// `XDG_DATA_HOME` / `XDG_STATE_HOME`, so pointing those at a temp directory
/// keeps the developer's real database and socket untouched.
final class LiveDaemon {
    let address: DaemonAddress
    let token: String
    private let process: Process
    private let root: URL
    private let logPath: URL
    private let binaryDirectory: URL

    enum StartError: Error, CustomStringConvertible {
        case binaryMissing(String)
        case seedFailed(command: String, status: Int32, output: String)

        var description: String {
            switch self {
            case .binaryMissing(let path):
                return "archcar not built at \(path). Run `cargo build -p archcar` (or `make ios-test`)."
            case .seedFailed(let command, let status, let output):
                return "seed step `\(command)` exited \(status): \(output)"
            }
        }
    }

    /// Throws rather than skipping when the binary is absent: this suite is the
    /// protocol-drift guard, and a guard that quietly no-ops is worse than none.
    static func start() throws -> LiveDaemon {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // .../Support
            .deletingLastPathComponent()  // .../ArchcarKitTests
            .deletingLastPathComponent()  // .../Tests
            .deletingLastPathComponent()  // .../ArchcarKit
            .deletingLastPathComponent()  // .../ios
            .deletingLastPathComponent()  // repository root
        let binary = repoRoot.appendingPathComponent("target/debug/archcar")
        guard FileManager.default.isExecutableFile(atPath: binary.path) else {
            throw StartError.binaryMissing(binary.path)
        }
        return try LiveDaemon(binary: binary)
    }

    private init(binary: URL) throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("archcar-ios-\(UUID().uuidString)")
        let data = root.appendingPathComponent("data")
        let state = root.appendingPathComponent("state")
        let archductorState = state.appendingPathComponent("archductor")
        for directory in [data, state, archductorState] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }

        token = UUID().uuidString
        // Writing the token up front avoids a rendezvous with the one the
        // daemon would otherwise generate on first start.
        try token.write(
            to: archductorState.appendingPathComponent("archcar.token"),
            atomically: true, encoding: .utf8)

        let port = UInt16.random(in: 20000...39000)
        address = DaemonAddress(host: "127.0.0.1", port: port)

        binaryDirectory = binary.deletingLastPathComponent()
        process = Process()
        process.executableURL = binary
        var environment = ProcessInfo.processInfo.environment
        environment["XDG_DATA_HOME"] = data.path
        environment["XDG_STATE_HOME"] = state.path
        environment["ARCHDUCTOR_ARCHCAR_LISTEN"] = String(port)
        process.environment = environment
        // Keep the daemon's own output: when this suite fails, the reason is
        // usually in here and nowhere else.
        logPath = root.appendingPathComponent("archcar.stderr.log")
        FileManager.default.createFile(atPath: logPath.path, contents: nil)
        let log = try FileHandle(forWritingTo: logPath)
        process.standardOutput = log
        process.standardError = log
        try process.run()
    }

    /// The daemon's stdout/stderr plus its log file, for failure messages.
    func diagnostics() -> String {
        let stderr = (try? String(contentsOf: logPath, encoding: .utf8)) ?? ""
        let daemonLog = root.appendingPathComponent("state/archductor/logs/archcar.log")
        let file = (try? String(contentsOf: daemonLog, encoding: .utf8)) ?? ""
        return """
        running: \(process.isRunning), exit: \(process.isRunning ? -1 : process.terminationStatus)
        stderr: \(stderr.suffix(2000))
        log: \(file.suffix(2000))
        """
    }

    /// Adds a repository and a workspace so chat tests have somewhere to live.
    /// Returns the workspace name.
    @discardableResult
    func seedWorkspace(named name: String = "phone-check") throws -> String {
        let repo = root.appendingPathComponent("repo")
        let parent = root.appendingPathComponent("ws")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        try run(git: ["init", "-q", "--initial-branch", "main", repo.path])
        try run(git: ["-C", repo.path, "-c", "user.email=t@t", "-c", "user.name=t",
                      "commit", "-q", "--allow-empty", "-m", "init"])
        try runCLI(["repo", "add", repo.path, "--name", "demo",
                    "--default-branch", "main", "--workspace-parent", parent.path])
        // A workspace needs an explicit branch unless it comes from an issue,
        // a PR, or a Linear ticket.
        try runCLI(["workspace", "create", "demo", "--name", name, "--branch", "feat/\(name)"])
        return name
    }

    private func run(git arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git"] + arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw StartError.seedFailed(
                command: "git \(arguments.joined(separator: " "))",
                status: process.terminationStatus,
                output: String(decoding: output, as: UTF8.self))
        }
    }

    private func runCLI(_ arguments: [String]) throws {
        let cli = binaryDirectory.appendingPathComponent("archductor")
        guard FileManager.default.isExecutableFile(atPath: cli.path) else {
            throw StartError.binaryMissing(cli.path)
        }
        let process = Process()
        process.executableURL = cli
        process.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment["XDG_DATA_HOME"] = root.appendingPathComponent("data").path
        environment["XDG_STATE_HOME"] = root.appendingPathComponent("state").path
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw StartError.seedFailed(
                command: "archductor \(arguments.joined(separator: " "))",
                status: process.terminationStatus,
                output: String(decoding: output, as: UTF8.self))
        }
    }

    func stop() {
        process.terminate()
        try? FileManager.default.removeItem(at: root)
    }
}
