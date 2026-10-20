import Foundation
import Network

@testable import ArchcarKit

/// An in-process stand-in for archcar: accepts connections, checks the token
/// line, and answers matched request lines.
///
/// The live-daemon suite proves the real protocol. This exists so the
/// transport's own edges — partial frames, auth rejection, mid-stream
/// disconnects — are testable without spawning a Rust binary.
actor MockDaemon {
    private let listener: NWListener
    private var connections: [NWConnection] = []
    private var framers: [ObjectIdentifier: LineFramer] = [:]
    private var tokenSeen: [ObjectIdentifier: Bool] = [:]
    private var expectedToken: String?
    private var matcher: (@Sendable (String) -> String?)?
    private(set) var receivedLines: [String] = []
    private(set) var tokenLine: String?
    private(set) var connectionCount = 0
    /// Connections that sent `subscribe`: the long-lived event streams.
    private var subscribers: [NWConnection] = []
    /// How many `subscribe` requests have arrived, across reconnects.
    private(set) var subscribeCount = 0
    /// Requests of this type are parked unanswered until `release()`.
    private var heldType: String?
    private var held: [(connection: NWConnection, line: String)] = []
    /// How many requests are parked by `hold(_:)`.
    var heldCount: Int { held.count }

    init() async throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        listener = try NWListener(using: parameters, on: .any)
        let box = UncheckedBox<MockDaemon>(self)
        listener.newConnectionHandler = { connection in
            Task { await box.value.accept(connection) }
        }
        listener.start(queue: .global())
        // The port is assigned asynchronously, and reads back as 0 — not nil —
        // until the listener is ready, so the wait has to check the value.
        for _ in 0..<500 where (listener.port?.rawValue ?? 0) == 0 {
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    var address: DaemonAddress {
        DaemonAddress(host: "127.0.0.1", port: listener.port?.rawValue ?? 0)
    }

    func requireToken(_ token: String) { expectedToken = token }

    func respond(to matcher: @escaping @Sendable (String) -> String?) {
        self.matcher = matcher
    }

    /// Parks every request of `type` without answering it, so a test can
    /// act while a store is suspended on that fetch.
    func hold(_ type: String) { heldType = type }

    /// Stops holding, and answers every parked request with the current
    /// matcher.
    func release() {
        heldType = nil
        let parked = held
        held.removeAll()
        for (connection, line) in parked {
            if let reply = matcher?(line) {
                connection.send(content: Data((reply + "\n").utf8), completion: .idempotent)
            }
        }
    }

    /// Pushes an unsolicited line to every open connection — the daemon's
    /// event stream, as far as a subscriber can tell.
    func push(_ line: String) {
        for connection in connections {
            connection.send(content: Data((line + "\n").utf8), completion: .idempotent)
        }
    }

    /// Drops only the event connection, leaving the listener up so the client
    /// can reconnect. Waits briefly for the `subscribe` line to land first,
    /// since the client's `connect` returns as soon as it has sent it.
    func endEventConnection() async {
        for _ in 0..<200 where subscribers.isEmpty {
            try? await Task.sleep(for: .milliseconds(10))
        }
        let ending = subscribers
        subscribers.removeAll()
        connections.removeAll { connection in ending.contains { $0 === connection } }
        for connection in ending { connection.cancel() }
    }

    /// Waits until at least `count` subscribes have arrived, or about two
    /// seconds have passed.
    func waitForSubscribes(_ count: Int, timeout: Duration = .seconds(2)) async {
        let deadline = ContinuousClock.now + timeout
        while subscribeCount < count, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func stop() {
        for connection in connections { connection.cancel() }
        connections.removeAll()
        listener.cancel()
    }

    private func accept(_ connection: NWConnection) {
        connectionCount += 1
        connections.append(connection)
        framers[ObjectIdentifier(connection)] = LineFramer()
        connection.start(queue: .global())
        receive(on: connection)
    }

    private func receive(on connection: NWConnection) {
        let box = UncheckedBox<MockDaemon>(self)
        let connectionBox = UncheckedBox<NWConnection>(connection)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
            if let data, !data.isEmpty {
                Task { await box.value.ingest(data, on: connectionBox.value) }
            }
            // A cancelled connection (see `endEventConnection`) reports an
            // error; asking it again would only spin.
            if !isComplete && error == nil {
                Task { await box.value.receive(on: connectionBox.value) }
            }
        }
    }

    private func ingest(_ data: Data, on connection: NWConnection) {
        let key = ObjectIdentifier(connection)
        var framer = framers[key] ?? LineFramer()
        let lines = framer.append(data)
        framers[key] = framer
        for line in lines {
            let text = String(decoding: line, as: UTF8.self)
            if tokenSeen[key] != true {
                tokenSeen[key] = true
                tokenLine = text
                if let expectedToken, text != expectedToken {
                    connection.send(
                        content: Data("{\"id\":\"auth\",\"payload\":{\"type\":\"error\",\"message\":\"archcar authentication failed\"}}\n".utf8),
                        completion: .contentProcessed { _ in connection.cancel() })
                }
                continue
            }
            receivedLines.append(text)
            if Self.isSubscribe(text) {
                subscribeCount += 1
                subscribers.append(connection)
            }
            if let heldType, Self.requestType(text) == heldType {
                held.append((connection, text))
                continue
            }
            if let reply = matcher?(text) ?? Self.handshakeProbeReply(to: text) {
                connection.send(content: Data((reply + "\n").utf8), completion: .idempotent)
            }
        }
    }
}

extension MockDaemon {
    static func isSubscribe(_ line: String) -> Bool {
        requestType(line) == "subscribe"
    }

    static func requestType(_ line: String) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let payload = object["payload"] as? [String: Any] else { return nil }
        return payload["type"] as? String
    }

    /// `DaemonSession.connect` proves its token with a `list_repositories`
    /// round trip, so a mock that never answers one would hang every connect.
    /// The real daemon always answers it; this keeps the stand-in honest.
    static func handshakeProbeReply(to line: String) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let id = object["id"] as? String,
              let payload = object["payload"] as? [String: Any],
              payload["type"] as? String == "list_repositories" else { return nil }
        return #"{"id":"\#(id)","payload":{"type":"repositories","repositories":[]}}"#
    }
}

/// Network.framework hands its callbacks back on its own queue, outside any
/// actor. This carries a reference across that boundary so the callback can
/// hop back onto the actor.
private final class UncheckedBox<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
