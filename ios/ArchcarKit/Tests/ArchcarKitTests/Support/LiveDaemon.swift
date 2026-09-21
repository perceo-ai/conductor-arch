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

    enum StartError: Error, CustomStringConvertible {
        case binaryMissing(String)

        var description: String {
            switch self {
            case .binaryMissing(let path):
                return "archcar not built at \(path). Run `cargo build -p archcar` (or `make ios-test`)."
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

    func stop() {
        process.terminate()
        try? FileManager.default.removeItem(at: root)
    }
}
