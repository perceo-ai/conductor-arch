import Foundation

public enum ConnectionState: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    case failed(String)
}

public enum DaemonSessionError: Error, Equatable, Sendable {
    case daemon(String)
    case authenticationFailed
    case disconnected
    case timedOut
    case closedWithoutResponse
}

/// One daemon, as the app talks to it.
///
/// The daemon serves exactly one request per connection: `handle_connection`
/// reads a single line after the token, answers it, and closes. So a request
/// here is a short-lived connection of its own, and the only long-lived socket
/// is the one holding `Subscribe` open for the event stream. This mirrors the
/// desktop client, which frames its traffic the same way.
public actor DaemonSession {
    public let address: DaemonAddress
    private let token: String
    /// A request that gets no answer must not hold a screen on a spinner.
    private let requestTimeout: Duration

    private var eventConnection: ArchcarConnection?
    /// One continuation per subscriber.
    ///
    /// A single shared `AsyncStream` would *split* events between consumers
    /// rather than broadcasting: each value goes to exactly one waiting
    /// iterator. With a chat, a review panel, and a terminal all observing, two
    /// of the three would silently miss everything.
    private var eventContinuations: [UUID: AsyncStream<ArchcarEvent>.Continuation] = [:]
    private var eventTask: Task<Void, Never>?
    private var backoff: Backoff

    /// Whoever is waiting in `waitUntilConnected`, released by the next
    /// successful connect. A stream rather than a checked continuation so a
    /// cancelled waiter (a view that went away) stops waiting on its own.
    private var connectedWaiters: [UUID: AsyncStream<Void>.Continuation] = [:]
    /// The backed-off retry loop that runs after the event stream drops.
    private var reconnectTask: Task<Void, Never>?
    /// The connect in progress, shared so a forced retry joins it rather than
    /// opening a second event socket alongside it.
    private var inFlightConnect: Task<Void, Error>?
    /// Set by `connect`, cleared by `disconnect`: a deliberate disconnect must
    /// not reconnect itself.
    private var wantsConnection = false
    /// Bumped by `disconnect`, so a connect already in flight when it was
    /// called does not come back and mark the session connected.
    private var lifecycle = 0

    /// What the event stream has said about the session behind each chat
    /// thread, keyed by thread id.
    ///
    /// The daemon replays every running session once, when a subscriber
    /// registers. This actor is that subscriber; a chat opened later was not
    /// there to see the replay, so it asks here instead.
    private struct KnownSession: Sendable {
        var sessionID: Int64
        var ready = false
    }
    private var knownSessions: [Int64: KnownSession] = [:]

    public private(set) var connectionState: ConnectionState = .disconnected

    /// The daemon's stable self-id, learned from the connect handshake. Nil
    /// until connected, or when the daemon predates it. Matched against the
    /// `daemon_self_id` a fresh APNs push carries.
    public private(set) var remoteDaemonSelfID: String?

    public init(
        address: DaemonAddress, token: String, requestTimeout: Duration = .seconds(20),
        backoff: Backoff = Backoff()
    ) {
        self.address = address
        self.token = token
        self.requestTimeout = requestTimeout
        self.backoff = backoff
    }

    deinit {
        reconnectTask?.cancel()
        eventTask?.cancel()
    }

    /// A fresh stream per caller. Every subscriber sees every event.
    ///
    /// The stream finishes when the event connection drops. A subscriber that
    /// wants to keep listening waits in `waitUntilConnected` and asks again.
    public var events: AsyncStream<ArchcarEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<ArchcarEvent>.makeStream()
        eventContinuations[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeSubscriber(id) }
        }
        return stream
    }

    private func removeSubscriber(_ id: UUID) {
        eventContinuations.removeValue(forKey: id)
    }

    /// A subscription to a live stream, for observers that run as long as a
    /// screen is open.
    public struct Subscription: Sendable {
        public let events: AsyncStream<ArchcarEvent>
        /// The session was not connected when asked, so whatever happened
        /// before this subscription was missed and should be refetched.
        public let waited: Bool
    }

    /// Subscribes once the session is connected, waiting first if it is not.
    ///
    /// A plain `events` taken while disconnected would sit unfinished through
    /// the reconnect with nothing to say events were missed; this hands out a
    /// stream only when one is flowing. Nil if the calling task is cancelled
    /// while waiting.
    public func connectedEvents() async -> Subscription? {
        var waited = false
        while connectionState != .connected {
            waited = true
            await waitUntilConnected()
            if Task.isCancelled { return nil }
        }
        return Subscription(events: events, waited: waited)
    }

    /// The session the event stream last reported for a chat thread, if it is
    /// still running.
    public func cachedSessionID(forThread threadID: Int64) -> Int64? {
        knownSessions[threadID]?.sessionID
    }

    /// Proves the token, then opens the event stream.
    ///
    /// The token check is a real round trip because a rejected token is only
    /// visible as a reply — without it the app would draw a connected daemon
    /// and discover the problem on the first request the user cares about.
    public func connect() async throws {
        wantsConnection = true
        guard connectionState != .connected else { return }
        if let inFlightConnect {
            try await inFlightConnect.value
            return
        }
        let lifecycle = self.lifecycle
        let attempt = Task { try await self.performConnect(lifecycle: lifecycle) }
        inFlightConnect = attempt
        defer { if inFlightConnect == attempt { inFlightConnect = nil } }
        try await attempt.value
    }

    private func performConnect(lifecycle: Int) async throws {
        connectionState = .connecting
        do {
            let handshake = try await request(ListRepositoriesRequest())
            if case let .repositories(_, daemonSelfID) = handshake {
                remoteDaemonSelfID = daemonSelfID
            }

            let events = ArchcarConnection(address: address, token: token)
            let lines: AsyncStream<Data>
            do {
                // Keepalive so a path that dies silently (a NAT that forgot
                // the mapping, a phone that changed networks) ends the stream
                // instead of leaving it open with nothing ever arriving.
                try await events.open(keepalive: true)
                lines = await events.lines
                try await events.send(try RequestEnvelope(body: SubscribeRequest()).encodedLine())
            } catch {
                await events.close()
                throw error
            }
            guard lifecycle == self.lifecycle else {
                await events.close()
                throw DaemonSessionError.disconnected
            }
            eventConnection = events
            // The daemon replays every running session on subscribe, so what
            // the last connection learned is about to be restated; a session
            // that exited while the link was down must not survive it.
            knownSessions.removeAll()
            startStreaming(lines, from: events)

            connectionState = .connected
            backoff.reset()
            releaseConnectedWaiters()
            ArchcarLog.session.notice(
                "connected host=\(self.address.host, privacy: .public) port=\(self.address.port, privacy: .public)")
        } catch {
            if lifecycle == self.lifecycle {
                connectionState = .failed(String(describing: error))
            }
            ArchcarLog.session.error(
                "connect failed host=\(self.address.host, privacy: .public) port=\(self.address.port, privacy: .public) error=\(String(describing: error), privacy: .public)")
            throw error
        }
    }

    public func disconnect() async {
        wantsConnection = false
        lifecycle += 1
        reconnectTask?.cancel()
        reconnectTask = nil
        inFlightConnect = nil
        eventTask?.cancel()
        eventTask = nil
        let connection = eventConnection
        eventConnection = nil
        knownSessions.removeAll()
        connectionState = .disconnected
        finishSubscribers()
        await connection?.close()
    }

    /// Returns once the session is connected: at once if it already is,
    /// otherwise after the next successful connect. Returns early if the
    /// calling task is cancelled.
    public func waitUntilConnected() async {
        guard connectionState != .connected else { return }
        let id = UUID()
        let (signal, continuation) = AsyncStream<Void>.makeStream()
        connectedWaiters[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeConnectedWaiter(id) }
        }
        for await _ in signal { break }
    }

    private func removeConnectedWaiter(_ id: UUID) {
        connectedWaiters.removeValue(forKey: id)
    }

    private func releaseConnectedWaiters() {
        let waiters = connectedWaiters.values
        connectedWaiters.removeAll()
        for waiter in waiters { waiter.finish() }
    }

    /// Tries to reconnect right away instead of waiting out the backoff — for
    /// the moments a retry is most likely to work: coming back to the front,
    /// or the network path changing. Does nothing while connected or after a
    /// deliberate `disconnect`. If this attempt fails too, the normal
    /// backed-off loop takes over from the first step.
    public func reconnectNow() {
        guard wantsConnection, connectionState != .connected else { return }
        backoff.reset()
        startReconnecting(immediately: true)
    }

    private func startReconnecting(immediately: Bool) {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            var waitFirst = !immediately
            while !Task.isCancelled {
                if waitFirst {
                    guard let delay = await self?.nextRetryDelay() else { return }
                    try? await Task.sleep(for: delay)
                    if Task.isCancelled { return }
                }
                waitFirst = true
                guard let self, await self.attemptReconnect() else { continue }
                return
            }
        }
    }

    /// One reconnect attempt. True when there is nothing left to retry: the
    /// session is connected, or it was deliberately disconnected.
    private func attemptReconnect() async -> Bool {
        guard wantsConnection else { return true }
        do {
            try await connect()
            return true
        } catch {
            return false
        }
    }

    /// Sends one request on its own connection and returns its response.
    public func request<Body: ArchcarRequestBody>(_ body: Body) async throws -> ArchcarResponse {
        let connection = ArchcarConnection(address: address, token: token)
        defer { Task { await connection.close() } }
        try await connection.open()
        let lines = await connection.lines
        let id = UUID().uuidString
        try await connection.send(try RequestEnvelope(id: id, body: body).encodedLine())

        guard let line = try await firstLine(of: lines) else {
            // Closed without answering. A rejected token is reported as an
            // `auth` error line, so it is not this; this is the daemon dying,
            // restarting, or the link dropping mid-request.
            throw DaemonSessionError.closedWithoutResponse
        }
        let envelope = try JSONDecoder().decode(ResponseEnvelope.self, from: line)
        switch envelope.payload {
        case .error(let message) where envelope.id == "auth" && message.contains("authentication failed"):
            throw DaemonSessionError.authenticationFailed
        case .error(let message):
            throw DaemonSessionError.daemon(message)
        case let payload:
            return payload
        }
    }

    private func firstLine(of lines: AsyncStream<Data>) async throws -> Data? {
        try await withThrowingTaskGroup(of: Data?.self) { group in
            group.addTask {
                for await line in lines { return line }
                return nil
            }
            group.addTask { [requestTimeout] in
                try await Task.sleep(for: requestTimeout)
                throw DaemonSessionError.timedOut
            }
            defer { group.cancelAll() }
            return try await group.next() ?? nil
        }
    }

    private func startStreaming(_ lines: AsyncStream<Data>, from connection: ArchcarConnection) {
        eventTask = Task { [weak self] in
            for await line in lines {
                await self?.handleEventLine(line)
            }
            await self?.handleEventStreamEnded(from: connection)
        }
    }

    private func handleEventLine(_ line: Data) {
        guard let envelope = try? JSONDecoder().decode(EventEnvelope.self, from: line) else { return }
        remember(envelope.payload)
        for continuation in eventContinuations.values {
            continuation.yield(envelope.payload)
        }
    }

    /// Keeps `knownSessions` in step with the events `ChatStore` treats as
    /// changing which session backs a thread.
    private func remember(_ event: ArchcarEvent) {
        switch event {
        case .sessionStarted(let sessionID, let threadID, _, _, _):
            knownSessions[threadID] = KnownSession(sessionID: sessionID)
        case .sessionReady(let sessionID, let threadID):
            var known = knownSessions[threadID] ?? KnownSession(sessionID: sessionID)
            if known.sessionID != sessionID { known = KnownSession(sessionID: sessionID) }
            known.ready = true
            knownSessions[threadID] = known
        case .sessionCapabilitiesChanged(let sessionID, let threadID, _):
            if knownSessions[threadID]?.sessionID != sessionID {
                knownSessions[threadID] = KnownSession(sessionID: sessionID)
            }
        case .sessionExited(let sessionID, _):
            knownSessions = knownSessions.filter { $0.value.sessionID != sessionID }
        default:
            break
        }
    }

    /// The event connection closed or failed. Every subscriber is told — a
    /// `for await` over a dead stream would otherwise wait forever while the
    /// screen above it looks live — and the session starts retrying.
    private func handleEventStreamEnded(from connection: ArchcarConnection) {
        // A stream closed by `disconnect` is not a drop to recover from.
        guard connection === eventConnection else { return }
        eventConnection = nil
        eventTask = nil
        finishSubscribers()
        guard connectionState == .connected else { return }
        connectionState = .disconnected
        ArchcarLog.session.notice(
            "event stream ended host=\(self.address.host, privacy: .public) port=\(self.address.port, privacy: .public)")
        if wantsConnection { startReconnecting(immediately: false) }
    }

    private func finishSubscribers() {
        let continuations = eventContinuations.values
        eventContinuations.removeAll()
        for continuation in continuations { continuation.finish() }
    }

    /// How long to wait before the next reconnect attempt. Drives the retry
    /// loop that starts when the event stream drops; `reconnectNow` resets it
    /// when a foreground or network-path change makes waiting pointless.
    public func nextRetryDelay() -> Duration { backoff.next() }
}
