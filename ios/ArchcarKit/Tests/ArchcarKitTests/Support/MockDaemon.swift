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

    /// Pushes an unsolicited line to every open connection — the daemon's
    /// event stream, as far as a subscriber can tell.
    func push(_ line: String) {
        for connection in connections {
            connection.send(content: Data((line + "\n").utf8), completion: .idempotent)
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
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, _ in
            if let data, !data.isEmpty {
                Task { await box.value.ingest(data, on: connectionBox.value) }
            }
            if !isComplete {
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
            if let reply = matcher?(text) {
                connection.send(content: Data((reply + "\n").utf8), completion: .idempotent)
            }
        }
    }
}

/// Network.framework hands its callbacks back on its own queue, outside any
/// actor. This carries a reference across that boundary so the callback can
/// hop back onto the actor.
private final class UncheckedBox<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
