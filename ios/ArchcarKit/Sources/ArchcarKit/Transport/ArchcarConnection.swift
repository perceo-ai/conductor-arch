import Foundation
import Network
import os

public enum ArchcarTransportError: Error, Equatable, Sendable {
    case notConnected
    case connectionFailed(String)
    case authenticationFailed
    case closed
}

/// Turns an `NWError` into the sentence a phone can act on.
///
/// Network.framework's own text ("The operation couldn't be completed") names
/// nothing the user owns. These three cases are the ones that actually happen:
/// the daemon is not running, the VPN is not up, or the machine is asleep — and
/// each has a different fix.
func connectionReason(_ error: NWError, address: DaemonAddress) -> String {
    switch error {
    case .posix(.ECONNREFUSED):
        return """
            \(address.host) refused the connection on port \(address.port). \
            The daemon is not listening — open the Archductor desktop app, or \
            check `archductor service status`.
            """
    case .posix(.EHOSTUNREACH), .posix(.ENETUNREACH), .posix(.EHOSTDOWN):
        return """
            No route to \(address.host). If that is a Tailscale address, turn \
            Tailscale on — on this phone and on the machine.
            """
    case .posix(.ETIMEDOUT):
        return """
            \(address.host) did not answer on port \(address.port). The machine \
            may be asleep, or something between you and it is dropping the port.
            """
    default:
        return "Could not reach \(address.host):\(address.port) — \(error.localizedDescription)"
    }
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
        // Bound locally so the state handler below can name the endpoint in its
        // errors without capturing the actor.
        let address = self.address
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
                    let reason = connectionReason(error, address: address)
                    ArchcarLog.transport.error(
                        "connect failed host=\(address.host, privacy: .public) port=\(address.port, privacy: .public) error=\(String(describing: error), privacy: .public)")
                    continuation.resume(throwing: ArchcarTransportError.connectionFailed(reason))
                case .waiting(let error):
                    // Network.framework parks a refused or unreachable endpoint
                    // in `.waiting` and retries forever. A phone wants to be
                    // told, so the retry decision stays with the caller.
                    let reason = connectionReason(error, address: address)
                    ArchcarLog.transport.error(
                        "connect waiting host=\(address.host, privacy: .public) port=\(address.port, privacy: .public) error=\(String(describing: error), privacy: .public)")
                    continuation.resume(throwing: ArchcarTransportError.connectionFailed(reason))
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
