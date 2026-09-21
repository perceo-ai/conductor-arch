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
    private var eventContinuation: AsyncStream<ArchcarEvent>.Continuation?
    private var eventStream: AsyncStream<ArchcarEvent>?
    private var eventTask: Task<Void, Never>?
    private var backoff = Backoff()

    public private(set) var connectionState: ConnectionState = .disconnected

    public init(address: DaemonAddress, token: String, requestTimeout: Duration = .seconds(20)) {
        self.address = address
        self.token = token
        self.requestTimeout = requestTimeout
    }

    public var events: AsyncStream<ArchcarEvent> {
        if let eventStream { return eventStream }
        let (stream, continuation) = AsyncStream<ArchcarEvent>.makeStream()
        eventStream = stream
        eventContinuation = continuation
        return stream
    }

    /// Proves the token, then opens the event stream.
    ///
    /// The token check is a real round trip because a rejected token is only
    /// visible as a reply — without it the app would draw a connected daemon
    /// and discover the problem on the first request the user cares about.
    public func connect() async throws {
        guard connectionState != .connected else { return }
        connectionState = .connecting
        do {
            _ = try await request(ListRepositoriesRequest())

            let events = ArchcarConnection(address: address, token: token)
            try await events.open()
            let lines = await events.lines
            try await events.send(try RequestEnvelope(body: SubscribeRequest()).encodedLine())
            eventConnection = events
            startStreaming(lines)

            connectionState = .connected
            backoff.reset()
        } catch {
            connectionState = .failed(String(describing: error))
            throw error
        }
    }

    public func disconnect() async {
        eventTask?.cancel()
        eventTask = nil
        await eventConnection?.close()
        eventConnection = nil
        connectionState = .disconnected
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
            // The daemon closes without answering only when it rejected the
            // token before reading the request.
            throw DaemonSessionError.authenticationFailed
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

    private func startStreaming(_ lines: AsyncStream<Data>) {
        eventTask = Task { [weak self] in
            for await line in lines {
                await self?.handleEventLine(line)
            }
            await self?.handleEventStreamEnded()
        }
    }

    private func handleEventLine(_ line: Data) {
        guard let envelope = try? JSONDecoder().decode(EventEnvelope.self, from: line) else { return }
        _ = events
        eventContinuation?.yield(envelope.payload)
    }

    private func handleEventStreamEnded() {
        eventConnection = nil
        if connectionState == .connected { connectionState = .disconnected }
    }

    /// How long to wait before the next reconnect attempt. The caller owns the
    /// retry loop, because on iOS the right moment to retry is usually a
    /// foreground or network-path change rather than a timer firing.
    public func nextRetryDelay() -> Duration { backoff.next() }
}
