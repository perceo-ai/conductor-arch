import ArchcarKit
import Foundation
import Network

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
    private var notificationObservation: Task<Void, Never>?
    private let localNotifications = LocalNotificationService()
    /// Watches for the network path changing — Wi-Fi to cellular, a VPN coming
    /// up — which is the moment a dropped session is most likely to come back.
    @ObservationIgnored private let pathMonitor = NWPathMonitor()
    @ObservationIgnored private var isMonitoringPath = false
    @ObservationIgnored private var pathObservation: Task<Void, Never>?

    init(directory: DaemonDirectory = DaemonDirectory()) {
        self.directory = directory
        localNotifications.hasLiveDaemonSession = { [weak self] in self?.session != nil }
    }

    func load() async {
        // UI tests need a fresh install every run; without this the first test
        // to pair a daemon changes what every later test starts from.
        if CommandLine.arguments.contains("--uitest-reset") {
            for daemon in await directory.all() { try? await directory.remove(id: daemon.id) }
        }
        saved = await directory.all()
        startMonitoringPath()
        if let active = await directory.active() {
            await activate(active)
        }
    }

    /// Asks the session to retry at once whenever the network path changes.
    ///
    /// The monitor also reports the current path as soon as it starts; that
    /// is harmless, because `reconnectNow` does nothing while connected. An
    /// unsatisfied path is skipped: an attempt with no route fails at once,
    /// and would only reset the backoff the retry loop is running.
    private func startMonitoringPath() {
        guard !isMonitoringPath else { return }
        isMonitoringPath = true
        // The handler runs on the monitor's own queue, so it only forwards
        // into a stream; the main actor reads it from there.
        let (paths, continuation) = AsyncStream<Bool>.makeStream(bufferingPolicy: .bufferingNewest(1))
        pathMonitor.pathUpdateHandler = { @Sendable path in
            continuation.yield(path.status == .satisfied)
        }
        pathMonitor.start(queue: DispatchQueue(label: "ai.perceo.archductor.path-monitor"))
        pathObservation = Task { [weak self] in
            for await satisfied in paths where satisfied {
                await self?.session?.reconnectNow()
            }
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
        notificationObservation = Task { await observeNotifications(session: session) }
        await localNotifications.requestAuthorizationAndRegister()
    }

    func refreshSavedList() async {
        saved = await directory.all()
    }

    func disconnect() async {
        observation?.cancel()
        observation = nil
        notificationObservation?.cancel()
        notificationObservation = nil
        await session?.disconnect()
        session = nil
        workspaces = nil
    }

    /// The socket does not survive suspension, so coming back to the front
    /// reconnects and refetches rather than trying to replay what was missed.
    ///
    /// An existing session is reconnected in place, not replaced: every open
    /// chat, review and terminal store holds this same `DaemonSession`, and
    /// each resubscribes and refetches once it reconnects. Building a new one
    /// would leave those screens bound to a session nobody reconnects.
    func handleForeground() async {
        guard let active = activeDaemon else { return }
        guard let session else {
            await activate(active)
            return
        }
        if await session.connectionState == .connected {
            await workspaces?.refresh()
        } else {
            await session.reconnectNow()
        }
    }

    private func observeNotifications(session: DaemonSession) async {
        while !Task.isCancelled {
            guard let subscription = await session.connectedEvents() else { return }
            for await event in subscription.events {
                guard let descriptor = EventNotificationDescriptor.from(event) else { continue }
                await localNotifications.deliver(descriptor)
            }
        }
    }

    func registerRemoteDeviceToken(_ token: String) async {
        guard let session else {
            ArchcarLog.notifications.notice("remote notification token arrived with no active daemon session")
            return
        }
        do {
            _ = try await session.request(
                RegisterNotificationDeviceRequest(
                    token: token,
                    appBundle: "ai.perceo.archductor.ios"))
            ArchcarLog.notifications.notice("registered remote notification device with daemon")
        } catch {
            ArchcarLog.notifications.error(
                "failed to register remote notification device: \(String(describing: error), privacy: .public)")
        }
    }
}
