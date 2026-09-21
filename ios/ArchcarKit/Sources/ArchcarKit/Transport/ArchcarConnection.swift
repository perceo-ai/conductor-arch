import Foundation
import Network
import os

public enum ArchcarTransportError: Error, Equatable, Sendable {
    case notConnected
    case connectionFailed(String)
    case authenticationFailed
    case closed
}

/// One TCP connection to archcar, framed as newline-delimited JSON.
///
/// The token goes out as the first line, before any RPC — the daemon reads
/// exactly one line for the handshake and rejects the connection if it does not
/// match. Nothing here interprets payloads; callers decode the lines.
public actor ArchcarConnection {
    private let address: DaemonAddress
    private let token: String
    private var connection: NWConnection?
    private var framer = LineFramer()
    private var continuation: AsyncStream<Data>.Continuation?
    private var stream: AsyncStream<Data>?

    public init(address: DaemonAddress, token: String) {
        self.address = address
        self.token = token
    }

    /// Lines received from the daemon, newline stripped.
    public var lines: AsyncStream<Data> {
        if let stream { return stream }
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        self.stream = stream
        self.continuation = continuation
        return stream
    }

    public func open() async throws {
        guard connection == nil else { return }
        _ = lines
        let endpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host(address.host),
            port: NWEndpoint.Port(rawValue: address.port) ?? NWEndpoint.Port(rawValue: DaemonAddress.defaultPort)!)
        let parameters = NWParameters.tcp
        let connection = NWConnection(to: endpoint, using: parameters)
        self.connection = connection

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let resumed = OSAllocatedUnfairLock(initialState: false)
            connection.stateUpdateHandler = { state in
                let shouldResume = resumed.withLock { alreadyResumed -> Bool in
                    guard !alreadyResumed else { return false }
                    switch state {
                    case .ready, .failed, .cancelled, .waiting: alreadyResumed = true; return true
                    default: return false
                    }
                }
                guard shouldResume else { return }
                switch state {
                case .ready:
                    continuation.resume()
                case .failed(let error):
                    continuation.resume(throwing: ArchcarTransportError.connectionFailed(error.localizedDescription))
                case .waiting(let error):
                    // Network.framework parks a refused or unreachable endpoint
                    // in `.waiting` and retries forever. A phone wants to be
                    // told, so the retry decision stays with the caller.
                    continuation.resume(throwing: ArchcarTransportError.connectionFailed(error.localizedDescription))
                case .cancelled:
                    continuation.resume(throwing: ArchcarTransportError.closed)
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))
        }

        receive()
        // The handshake line: the token, then a newline, then nothing until the
        // daemon has accepted it.
        try await send(Data((token + "\n").utf8))
    }

    public func send(_ line: Data) async throws {
        guard let connection else { throw ArchcarTransportError.notConnected }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: line, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: ArchcarTransportError.connectionFailed(error.localizedDescription))
                } else {
                    continuation.resume()
                }
            })
        }
    }

    public func close() {
        connection?.cancel()
        connection = nil
        continuation?.finish()
        continuation = nil
        stream = nil
    }

    private func receive() {
        guard let connection else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            Task { await self.handle(data: data, isComplete: isComplete, error: error) }
        }
    }

    private func handle(data: Data?, isComplete: Bool, error: NWError?) {
        if let data, !data.isEmpty {
            for line in framer.append(data) {
                continuation?.yield(line)
            }
        }
        if isComplete || error != nil {
            continuation?.finish()
            continuation = nil
            connection?.cancel()
            connection = nil
            return
        }
        receive()
    }
}
