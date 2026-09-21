import Foundation

/// A shell session's screen, polled and typed into.
///
/// Not a terminal emulator: the daemon already renders the VT100 screen to
/// text, so the phone shows that text and sends keystrokes back. Reading, and
/// the occasional command, is the target — driving vim from a phone is not.
@MainActor
@Observable
public final class TerminalStore {
    public private(set) var screen = ""

    /// The screen without its trailing blank rows.
    ///
    /// A VT100 screen is a fixed grid, so the daemon's render pads to the full
    /// height. Showing that verbatim and anchoring to the bottom — which is
    /// what a terminal should do — parks the view on the blank filler with the
    /// output scrolled out of sight.
    public var displayScreen: String {
        var lines = screen.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) }
        while let last = lines.last, last.isEmpty { lines.removeLast() }
        return lines.joined(separator: "\n")
    }
    public private(set) var sessionID: Int64?
    public private(set) var isStarting = false
    public private(set) var lastError: String?

    private let session: DaemonSession
    public let workspace: String

    public init(session: DaemonSession, workspace: String) {
        self.session = session
        self.workspace = workspace
    }

    /// Attaches to this workspace's shell, starting one if it has none.
    ///
    /// `spawn_session` answers `session_spawn_queued` with no id, so the
    /// session has to be identified afterwards. The authoritative answer is the
    /// `session_started` event, which names the workspace *and* the kind, and
    /// this subscribes before spawning so the event cannot be missed. The
    /// processes report is only a fallback, and it is filtered to shells:
    /// agent sessions appear in the same list, and sending raw keystrokes into
    /// a running Codex or Claude session would be worse than showing nothing.
    public func start() async {
        guard sessionID == nil else { return }
        isStarting = true
        defer { isStarting = false }

        if let existing = await runningShellSessionID() {
            sessionID = existing
            await refreshScreen()
            return
        }

        // Subscribe first: the event can land before the spawn call returns.
        let events = await session.events

        do {
            let response = try await session.request(
                SpawnSessionRequest(workspace: workspace, kind: .shell))
            if case .sessionSpawned(let id, _, _, _) = response {
                sessionID = id
                await refreshScreen()
                return
            }
        } catch {
            lastError = String(describing: error)
            return
        }

        var resolved = await awaitSpawnedShell(on: events)
        if resolved == nil { resolved = await runningShellSessionID() }
        if let id = resolved {
            sessionID = id
            await refreshScreen()
            return
        }
        lastError = "The daemon did not report a shell for this workspace."
    }

    /// Waits for the `session_started` that belongs to this workspace's shell.
    private func awaitSpawnedShell(on events: AsyncStream<ArchcarEvent>) async -> Int64? {
        let workspace = workspace
        return await withTaskGroup(of: Int64?.self) { group in
            group.addTask {
                for await event in events {
                    if case .sessionStarted(let id, _, let eventWorkspace, let kind, _) = event,
                       eventWorkspace == workspace, kind == .shell {
                        return id
                    }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(10))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// The newest running *shell* in this workspace, from the processes report.
    private func runningShellSessionID() async -> Int64? {
        guard case .workspaceProcesses(_, let text)? = try? await session.request(
            GetWorkspaceProcessesRequest(workspace: workspace)) else { return nil }
        return TerminalStore.newestRunningShell(in: text)
    }

    /// Commands that count as a shell in the processes report. Agent sessions
    /// are listed the same way and must not be attached to.
    private nonisolated static let shellCommands: Set<String> = ["sh", "bash", "zsh", "fish", "dash", "ksh"]

    /// Parses the `Sessions` block and returns the newest running shell.
    ///
    /// Lines look like `#2 /bin/zsh running pid=32518 exit=- started=…`. The
    /// daemon has no structured session listing, so the text is the interface;
    /// a line that does not parse is skipped rather than failing the lookup.
    public nonisolated static func newestRunningShell(in report: String) -> Int64? {
        var inSessions = false
        var newest: Int64?
        for rawLine in report.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line == "Sessions" {
                inSessions = true
                continue
            }
            if !inSessions { continue }
            if !line.hasPrefix("#") && !line.isEmpty && !line.contains("pid=") { break }
            guard line.hasPrefix("#"), line.contains(" running ") else { continue }
            let fields = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
            guard fields.count >= 2, let value = Int64(fields[0].dropFirst()) else { continue }
            let command = fields[1].split(separator: "/").last.map(String.init) ?? String(fields[1])
            guard shellCommands.contains(command) else { continue }
            newest = max(newest ?? value, value)
        }
        return newest
    }


    /// Test seam: attaches to a known session without spawning one.
    public func attachForTesting(sessionID: Int64) {
        self.sessionID = sessionID
    }

    public func refreshScreen() async {
        guard let sessionID else { return }
        do {
            let response = try await session.request(GetSessionScreenRequest(sessionID: sessionID))
            guard case .sessionScreen(_, let screen) = response else { return }
            self.screen = screen
            lastError = nil
        } catch {
            lastError = String(describing: error)
        }
    }

    /// Sends a line, with the newline that runs it.
    public func send(_ text: String) async {
        guard let sessionID else { return }
        _ = try? await session.request(
            SendInputRequest(sessionID: sessionID, input: text + "\n", kind: .rawTerminal))
        await refreshScreen()
    }

    /// Sends a control byte such as ctrl-C, which is how you stop something
    /// from a phone that has no control key.
    public func sendControl(_ letter: Character) async {
        guard let sessionID, let ascii = letter.uppercased().unicodeScalars.first?.value,
              ascii >= 64, ascii < 96 else { return }
        let byte = String(UnicodeScalar(ascii - 64)!)
        _ = try? await session.request(
            SendInputRequest(sessionID: sessionID, input: byte, kind: .rawTerminal))
        await refreshScreen()
    }

    public func resize(rows: Int, cols: Int) async {
        guard let sessionID else { return }
        _ = try? await session.request(
            ResizeSessionRequest(sessionID: sessionID, rows: rows, cols: cols))
    }

    /// Follows the session's screen updates rather than polling on a timer: the
    /// daemon already emits an event per change.
    public func observe() async {
        for await event in await session.events {
            switch event {
            case .sessionStarted(let id, _, let eventWorkspace, let kind, _)
                where eventWorkspace == workspace && kind == .shell && sessionID == nil:
                sessionID = id
                await refreshScreen()
            case .sessionScreenUpdated(let id) where id == sessionID:
                await refreshScreen()
            case .sessionExited(let id, _) where id == sessionID:
                sessionID = nil
            default:
                continue
            }
        }
    }
}
