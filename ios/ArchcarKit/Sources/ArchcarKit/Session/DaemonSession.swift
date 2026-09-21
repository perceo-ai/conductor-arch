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
}

/// One daemon, as the app talks to it.
///
/// Two sockets, because `Subscribe` occupies its connection for as long as it
/// lives: the command socket carries request/response traffic, the event socket
/// sends `subscribe` once and then only reads. Requests are correlated by
/// envelope id, so several can be in flight at once.
public actor DaemonSession {
    public let address: DaemonAddress
    private let token: String

    private var commandConnection: ArchcarConnection?
    private var eventConnection: ArchcarConnection?
    private var pending: [String: CheckedContinuation<ArchcarResponse, Error>] = [:]
    private var eventContinuation: AsyncStream<ArchcarEvent>.Continuation?
    private var eventStream: AsyncStream<ArchcarEvent>?
    private var readerTask: Task<Void, Never>?
    private var eventTask: Task<Void, Never>?
    private var backoff = Backoff()
    /// Set when the daemon rejects our token. A rejection arrives as one
    /// unsolicited line and is followed immediately by the socket closing, so
    /// without this the close would be reported as a plain disconnect.
    private var sawAuthenticationFailure = false

    public private(set) var connectionState: ConnectionState = .disconnected

    public init(address: DaemonAddress, token: String) {
        self.address = address
        self.token = token
    }

    public var events: AsyncStream<ArchcarEvent> {
        if let eventStream { return eventStream }
        let (stream, continuation) = AsyncStream<ArchcarEvent>.makeStream()
        eventStream = stream
        eventContinuation = continuation
        return stream
    }

    public func connect() async throws {
        guard connectionState != .connected else { return }
        connectionState = .connecting
        sawAuthenticationFailure = false
        do {
            let command = ArchcarConnection(address: address, token: token)
            try await command.open()
            commandConnection = command
            startReading(command)

            // Prove the token before reporting a connection. A bad one is only
            // visible as a reply, so without a round trip here the first real
            // request is where the user would find out — and by then the app
            // has already drawn a connected daemon.
            try await withHandshakeTimeout { try await self.request(ListRepositoriesRequest()) }

            let events = ArchcarConnection(address: address, token: token)
            try await events.open()
            eventConnection = events
            try await events.send(try RequestEnvelope(body: SubscribeRequest()).encodedLine())
            startStreaming(events)

            connectionState = .connected
            backoff.reset()
        } catch {
            connectionState = .failed(String(describing: error))
            throw error
        }
    }

    public func disconnect() async {
        readerTask?.cancel()
        eventTask?.cancel()
        readerTask = nil
        eventTask = nil
        await commandConnection?.close()
        await eventConnection?.close()
        commandConnection = nil
        eventConnection = nil
        failPending(with: .disconnected)
        connectionState = .disconnected
    }

    public func request<Body: ArchcarRequestBody>(_ body: Body) async throws -> ArchcarResponse {
        if sawAuthenticationFailure { throw DaemonSessionError.authenticationFailed }
        guard let connection = commandConnection else { throw DaemonSessionError.disconnected }
        let id = UUID().uuidString
        let line = try RequestEnvelope(id: id, body: body).encodedLine()
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task {
                do {
                    try await connection.send(line)
                } catch {
                    await resume(id: id, with: .failure(error))
                }
            }
        }
    }

    private func startReading(_ connection: ArchcarConnection) {
        readerTask = Task { [weak self] in
            for await line in await connection.lines {
                await self?.handleResponseLine(line)
            }
            await self?.handleDisconnect()
        }
    }

    private func startStreaming(_ connection: ArchcarConnection) {
        eventTask = Task { [weak self] in
            for await line in await connection.lines {
                await self?.handleEventLine(line)
            }
        }
    }

    private func handleResponseLine(_ line: Data) {
        guard let envelope = try? JSONDecoder().decode(ResponseEnvelope.self, from: line) else { return }
        // The daemon answers a failed handshake with id "auth" — a line no
        // request asked for, which is how a bad token is told apart from a
        // rejected request.
        if envelope.id == "auth", case .error(let message) = envelope.payload,
           message.contains("authentication failed") {
            sawAuthenticationFailure = true
            failPending(with: .authenticationFailed)
            connectionState = .failed(message)
            return
        }
        switch envelope.payload {
        case .error(let message):
            resume(id: envelope.id, with: .failure(DaemonSessionError.daemon(message)))
        case let payload:
            resume(id: envelope.id, with: .success(payload))
        }
    }

    private func handleEventLine(_ line: Data) {
        guard let envelope = try? JSONDecoder().decode(EventEnvelope.self, from: line) else { return }
        _ = events
        eventContinuation?.yield(envelope.payload)
    }

    private func handleDisconnect() {
        commandConnection = nil
        if connectionState == .connected { connectionState = .disconnected }
        failPending(with: sawAuthenticationFailure ? .authenticationFailed : .disconnected)
    }

    private func resume(id: String, with result: Result<ArchcarResponse, Error>) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        continuation.resume(with: result)
    }

    private func failPending(with error: DaemonSessionError) {
        let waiting = pending
        pending.removeAll()
        for (_, continuation) in waiting { continuation.resume(throwing: error) }
    }

    /// A daemon that accepts the TCP connection and then says nothing must not
    /// leave the app on a spinner forever.
    private func withHandshakeTimeout(
        _ operation: @escaping @Sendable () async throws -> ArchcarResponse
    ) async throws {
        try await withThrowingTaskGroup(of: ArchcarResponse.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(for: .seconds(10))
                throw ArchcarTransportError.connectionFailed("daemon did not answer the handshake")
            }
            defer { group.cancelAll() }
            _ = try await group.next()
        }
    }

    /// How long to wait before the next reconnect attempt. The caller owns the
    /// retry loop, because on iOS the right moment to retry is usually a
    /// foreground or network-path change rather than a timer firing.
    public func nextRetryDelay() -> Duration { backoff.next() }
}
