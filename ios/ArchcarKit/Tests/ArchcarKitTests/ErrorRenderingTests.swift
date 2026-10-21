import Foundation
import Security
import Testing

@testable import ArchcarKit

// Stores put `UserFacingMessage.describing(error)` into the fields the screens
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

/// Answers each request `type` in `replies` with that payload, and nothing
/// else; the handshake still gets the mock's own answer.
private func replying(_ replies: [String: String]) -> @Sendable (String) -> String? {
    { line in
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let id = object["id"] as? String,
              let type = MockDaemon.requestType(line),
              let payload = replies[type] else { return nil }
        return #"{"id":"\#(id)","payload":\#(payload)}"#
    }
}

@MainActor
@Test func aCancelledRequestReadsAsInterruptedNotFailed() async throws {
    // Cancelling the store's task cancels `DaemonSession.firstLine`'s timeout
    // sleep, and Foundation renders the resulting `CancellationError` as "The
    // operation couldn't be completed. (Swift.CancellationError error 1.)".
    let daemon = try await MockDaemon()
    await daemon.hold("get_inventory_snapshot")
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = WorkspacesStore(session: session)
    let refreshing = Task { await store.refresh() }
    #expect(await eventually { await daemon.heldCount == 1 })
    refreshing.cancel()
    await refreshing.value

    let shown = try #require(store.lastError)
    #expect(shown == "The request was interrupted before the daemon answered.")
    #expect(!shown.contains("Swift.CancellationError"))
    #expect(!shown.localizedCaseInsensitiveContains("fail"))
    // A resolve sheet must not call an interrupted answer unreachable either.
    #expect(ChatStore.resolveFailureMessage(for: CancellationError()) == shown)
    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func anUnexpectedActionResponseReadsAsASentenceOnTheReviewScreen() async throws {
    // A newer daemon's reply type decodes as `.unknown`, which the review
    // screen used to print as `unknown(type: "branch_pushed_v2")`.
    let daemon = try await MockDaemon()
    await daemon.respond(to: replying([
        "push_branch": #"{"type":"branch_pushed_v2","remote":"origin"}"#,
        "get_checks_summary": #"{"type":"error","message":"not under test"}"#,
        "list_workflow_runs": #"{"type":"error","message":"not under test"}"#,
    ]))
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = ReviewStore(session: session, workspace: "w")
    await store.push()

    let shown = try #require(store.actionOutput)
    print("ERRPROBE store.actionOutput=\(shown)")
    #expect(shown == "The daemon sent an answer this app could not use.")
    for marker in dumpMarkers + ["unknown(", "branch_pushed_v2"] {
        #expect(!shown.contains(marker), "\(marker) leaked into: \(shown)")
    }
    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func anUnexpectedInventoryResponseReadsAsASentenceInTheStaleBanner() async throws {
    // `WorkspacesStore.lastError` feeds the stale banner; it used to read
    // `unexpected response: unknown(type: "inventory_snapshot_v2")`.
    let daemon = try await MockDaemon()
    await daemon.respond(to: replying([
        "get_inventory_snapshot": #"{"type":"inventory_snapshot_v2","repositories":[]}"#,
    ]))
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = WorkspacesStore(session: session)
    await store.refresh()

    let shown = try #require(store.lastError)
    print("ERRPROBE store.lastError=\(shown)")
    #expect(shown == "The daemon sent an answer this app could not use.")
    for marker in dumpMarkers + ["unknown(", "inventory_snapshot_v2"] {
        #expect(!shown.contains(marker), "\(marker) leaked into: \(shown)")
    }
    await session.disconnect()
    await daemon.stop()
}

/// Always fails `setToken`, as a device locked under
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` does.
private struct FailingTokenStore: TokenStore {
    func token(for id: String) throws -> String? { nil }
    func setToken(_ token: String, for id: String) throws {
        throw KeychainTokenStore.KeychainError.status(errSecInteractionNotAllowed)
    }
    func removeToken(for id: String) throws {}
}

@Test func keychainErrorsRenderAsSentences() {
    #expect(String(describing: KeychainTokenStore.KeychainError.status(errSecInteractionNotAllowed))
        == "Unlock this device and try again.")
    #expect(String(describing: KeychainTokenStore.KeychainError.status(errSecDuplicateItem))
        == "A token for this daemon is already saved.")
    #expect(String(describing: KeychainTokenStore.KeychainError.status(-1))
        == "Could not reach the keychain.")
    let errors: [any Error] = [
        KeychainTokenStore.KeychainError.status(errSecInteractionNotAllowed),
        KeychainTokenStore.KeychainError.status(errSecDuplicateItem),
    ]
    for error in errors {
        #expect(error.localizedDescription == String(describing: error))
    }
}

@Test func aLockedKeychainFailureReadsAsASentenceOnThePairingSheet() async throws {
    // PairDaemonView.save() renders DaemonDirectory.add's thrown error as
    // "Could not save: \(UserFacingMessage.describing(failure))". A real
    // Keychain write cannot be forced to fail from a test, so this drives the
    // same throw through a TokenStore double for a locked device.
    let directory = DaemonDirectory(
        records: UserDefaultsRecordStore(suiteName: "test-\(UUID().uuidString)"),
        tokens: FailingTokenStore())

    do {
        _ = try await directory.add(label: "s", address: DaemonAddress(host: "h"), token: "t")
        Issue.record("DaemonDirectory.add did not throw")
        return
    } catch let failure {
        let shown = "Could not save: \(UserFacingMessage.describing(failure))"
        print("ERRPROBE PairDaemonView.error=\(shown)")
        #expect(shown == "Could not save: Unlock this device and try again.")
        for marker in dumpMarkers + ["status(", "errSecInteractionNotAllowed", "-25308"] {
            #expect(!shown.contains(marker), "\(marker) leaked into: \(shown)")
        }
    }
}
