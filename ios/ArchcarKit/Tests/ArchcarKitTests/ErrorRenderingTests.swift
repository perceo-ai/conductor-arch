import Foundation
import Testing

@testable import ArchcarKit

// Stores put `String(describing: error)` straight into the fields the screens
// and the stale banner show, so these sentences are what the user reads. Every
// case is listed: a new case must get a sentence, not fall back to its name.

@Test func daemonSessionErrorsRenderAsSentences() {
    #expect(String(describing: DaemonSessionError.daemon("gh is not authenticated"))
        == "The daemon said: gh is not authenticated")
    #expect(String(describing: DaemonSessionError.authenticationFailed) == "Authentication failed.")
    #expect(String(describing: DaemonSessionError.disconnected) == "Connection to the daemon was lost.")
    #expect(String(describing: DaemonSessionError.timedOut) == "The request timed out.")
    #expect(String(describing: DaemonSessionError.closedWithoutResponse)
        == "The daemon closed the connection before confirming.")
}

@Test func transportErrorsRenderAsSentences() {
    #expect(String(describing: ArchcarTransportError.notConnected) == "Not connected to the daemon.")
    #expect(String(describing: ArchcarTransportError.connectionFailed("Socket is not connected"))
        == "The connection to the daemon failed: Socket is not connected")
    #expect(String(describing: ArchcarTransportError.authenticationFailed) == "Authentication failed.")
    #expect(String(describing: ArchcarTransportError.closed) == "The daemon closed the connection.")
}

@Test func errorsRenderTheSameWhenTypeErased() {
    // The stores catch `any Error`; the sentence must survive the erasure.
    let errors: [any Error] = [DaemonSessionError.timedOut, ArchcarTransportError.closed]
    #expect(errors.map { String(describing: $0) }
        == ["The request timed out.", "The daemon closed the connection."])
}

@Test func localizedDescriptionIsTheSameSentence() {
    // Foundation's default for a Swift enum is "The operation couldn't be
    // completed. (ArchcarKit.… error N.)"; the screens read localizedDescription.
    let errors: [any Error] = [
        DaemonSessionError.daemon("gh is not authenticated"), DaemonSessionError.authenticationFailed,
        DaemonSessionError.disconnected, DaemonSessionError.timedOut, DaemonSessionError.closedWithoutResponse,
        ArchcarTransportError.notConnected, ArchcarTransportError.connectionFailed("Socket is not connected"),
        ArchcarTransportError.authenticationFailed, ArchcarTransportError.closed,
    ]
    for error in errors {
        #expect(error.localizedDescription == String(describing: error))
    }
}

/// Swift value syntax that must never reach a screen.
private let dumpMarkers = ["CodingKeys", "Swift.", "Context(", "(stringValue:"]

@MainActor
@Test func aMalformedResponseDoesNotDumpTheDecodingError() async throws {
    // `DaemonSession.request` decodes the reply with a bare `try`, so a reply
    // the app cannot read reaches the store as a `DecodingError`, not one of
    // ArchcarKit's own errors.
    let daemon = try await MockDaemon()
    await daemon.respond { line in
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let id = object["id"] as? String,
              let payload = object["payload"] as? [String: Any],
              payload["type"] as? String == "get_inventory_snapshot" else { return nil }
        return #"{"id":"\#(id)","payload":{"type":"inventory_snapshot","repositories":"not a list","workspaces":[],"chat_threads":{}}}"#
    }
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = WorkspacesStore(session: session)
    await store.refresh()

    let shown = try #require(store.lastError)
    print("ERRPROBE store.lastError=\(shown)")
    #expect(!shown.isEmpty)
    for marker in dumpMarkers {
        #expect(!shown.contains(marker), "\(marker) leaked into: \(shown)")
    }
    await session.disconnect()
    await daemon.stop()
}
