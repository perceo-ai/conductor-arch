import ArchcarKit
import Foundation

/// Which daemon the app is talking to, and the stores hanging off it.
///
/// One active daemon at a time, matching the desktop: the active client owns
/// the workspaces and sessions you see, and switching replaces them wholesale.
@MainActor
@Observable
final class AppModel {
    let directory: DaemonDirectory
    private(set) var saved: [SavedDaemon] = []
    private(set) var activeDaemon: SavedDaemon?
    private(set) var session: DaemonSession?
    private(set) var workspaces: WorkspacesStore?
    private(set) var connectionError: String?
    private(set) var isConnecting = false

    private var observation: Task<Void, Never>?

    init(directory: DaemonDirectory = DaemonDirectory()) {
        self.directory = directory
    }

    func load() async {
        // UI tests need a fresh install every run; without this the first test
        // to pair a daemon changes what every later test starts from.
        if CommandLine.arguments.contains("--uitest-reset") {
            for daemon in await directory.all() { try? await directory.remove(id: daemon.id) }
        }
        saved = await directory.all()
        if let active = await directory.active() {
            await activate(active)
        }
    }

    func activate(_ daemon: SavedDaemon) async {
        await disconnect()
        await directory.setActive(daemon.id)
        activeDaemon = daemon
        isConnecting = true
        defer { isConnecting = false }

        // `try?` already flattens the store's optional, so one binding is all
        // that is needed to mean "no token saved for this daemon".
        guard let token = try? await directory.token(for: daemon.id), !token.isEmpty else {
            connectionError = "No saved token for \(daemon.label). Pair this daemon again."
            return
        }
        let session = DaemonSession(address: daemon.address, token: token)
        do {
            try await session.connect()
        } catch DaemonSessionError.authenticationFailed {
            connectionError = "\(daemon.label) rejected the saved token. Pair again to get a fresh one."
            return
        } catch ArchcarTransportError.connectionFailed(let reason) {
            // The transport already worked out which of "not running", "not on
            // the VPN", and "asleep" this is; repeating a generic question here
            // would throw that away.
            connectionError = reason
            return
        } catch {
            connectionError =
                "Could not reach \(daemon.address.host):\(daemon.address.port) — \(error.localizedDescription)"
            return
        }
        connectionError = nil
        self.session = session
        let store = WorkspacesStore(session: session)
        workspaces = store
        await store.refresh()
        observation = Task { await store.observe() }
    }

    func refreshSavedList() async {
        saved = await directory.all()
    }

    func disconnect() async {
        observation?.cancel()
        observation = nil
        await session?.disconnect()
        session = nil
        workspaces = nil
    }

    /// The socket does not survive suspension, so coming back to the front
    /// reconnects and refetches rather than trying to replay what was missed.
    func handleForeground() async {
        guard let active = activeDaemon else { return }
        guard let session else {
            await activate(active)
            return
        }
        if await session.connectionState == .connected {
            await workspaces?.refresh()
        } else {
            await activate(active)
        }
    }
}
