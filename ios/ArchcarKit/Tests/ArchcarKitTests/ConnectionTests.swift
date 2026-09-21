import Foundation
import Testing

@testable import ArchcarKit

@Test func parsesAddressForms() throws {
    #expect(DaemonAddress("mac-studio.tailnet.ts.net")?.port == 7420)
    #expect(DaemonAddress("10.0.0.4:9000")?.host == "10.0.0.4")
    #expect(DaemonAddress("10.0.0.4:9000")?.port == 9000)
    #expect(DaemonAddress("[fd00::1]:7420")?.host == "fd00::1")
    #expect(DaemonAddress("") == nil)
    #expect(DaemonAddress("host:notaport") == nil)
}

@Test func sendsTokenAsFirstLine() async throws {
    let daemon = try await MockDaemon()
    await daemon.requireToken("s3cret")
    await daemon.respond { _ in #"{"id":"1","payload":{"type":"ack"}}"# }

    let connection = ArchcarConnection(address: await daemon.address, token: "s3cret")
    try await connection.open()
    let stream = await connection.lines
    try await connection.send(try RequestEnvelope(id: "1", body: ListWorkspacesRequest()).encodedLine())

    var received: [Data] = []
    for await line in stream {
        received.append(line)
        break
    }
    #expect(await daemon.tokenLine == "s3cret")
    #expect(received.count == 1)
    await connection.close()
    await daemon.stop()
}

@Test func reportsAuthenticationFailure() async throws {
    let daemon = try await MockDaemon()
    await daemon.requireToken("right")

    let connection = ArchcarConnection(address: await daemon.address, token: "wrong")
    try await connection.open()
    let stream = await connection.lines
    try await connection.send(try RequestEnvelope(id: "1", body: ListWorkspacesRequest()).encodedLine())

    var lines: [Data] = []
    for await line in stream {
        lines.append(line)
        break
    }
    let envelope = try JSONDecoder().decode(ResponseEnvelope.self, from: try #require(lines.first))
    guard case .error(let message) = envelope.payload else {
        Issue.record("expected error payload")
        return
    }
    #expect(message == "archcar authentication failed")
    await connection.close()
    await daemon.stop()
}

@Test func openFailsFastOnARefusedPort() async throws {
    // Port 1 on loopback has nothing listening; the connection must surface a
    // failure rather than hang the caller forever.
    let connection = ArchcarConnection(address: DaemonAddress(host: "127.0.0.1", port: 1), token: "t")
    await #expect(throws: ArchcarTransportError.self) {
        try await connection.open()
    }
}
