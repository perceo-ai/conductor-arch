import Foundation
import Testing

@testable import ArchcarKit

@Test func decodesPairingPayload() throws {
    let scanned = #"{"v":1,"label":"mac studio","address":"10.0.0.4:7420","token":"abc123"}"#
    let payload = try PairingPayload.decode(scanned)
    #expect(payload.label == "mac studio")
    #expect(payload.address.host == "10.0.0.4")
    #expect(payload.address.port == 7420)
    #expect(payload.token == "abc123")
}

@Test func rejectsFuturePayloadVersion() throws {
    let scanned = #"{"v":2,"label":"x","address":"h:1","token":"t"}"#
    #expect(throws: PairingError.unsupportedVersion(2)) {
        _ = try PairingPayload.decode(scanned)
    }
}

@Test func rejectsGarbageScan() throws {
    #expect(throws: PairingError.malformed) {
        _ = try PairingPayload.decode("https://example.invalid")
    }
}

@Test func rejectsUnparseableAddress() throws {
    #expect(throws: PairingError.badAddress) {
        _ = try PairingPayload.decode(#"{"v":1,"label":"x","address":"h:notaport","token":"t"}"#)
    }
}

@Test func payloadRoundTrips() throws {
    let payload = PairingPayload(
        label: "studio", address: DaemonAddress(host: "fd00::1", port: 7420), token: "t")
    #expect(try PairingPayload.decode(try payload.encoded()) == payload)
}

@Test func directoryStoresTokensOutsideDefaults() async throws {
    let suite = "test-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    let directory = DaemonDirectory(
        records: UserDefaultsRecordStore(suiteName: suite), tokens: InMemoryTokenStore())

    let saved = try await directory.add(
        label: "studio", address: DaemonAddress(host: "10.0.0.4"), token: "s3cret")
    #expect(await directory.all().count == 1)
    #expect(try await directory.token(for: saved.id) == "s3cret")

    // The token must never reach the plist that backs UserDefaults.
    let dump = String(describing: defaults.dictionaryRepresentation())
    #expect(!dump.contains("s3cret"))
}

@Test func directoryRemovesTokenWithDaemon() async throws {
    let directory = DaemonDirectory(
        records: UserDefaultsRecordStore(suiteName: "test-\(UUID().uuidString)"),
        tokens: InMemoryTokenStore())

    let saved = try await directory.add(label: "s", address: DaemonAddress(host: "h"), token: "t")
    try await directory.remove(id: saved.id)
    #expect(await directory.all().isEmpty)
    #expect(try await directory.token(for: saved.id) == nil)
}

@Test func directorySurvivesReload() async throws {
    let suite = "test-\(UUID().uuidString)"
    let tokens = InMemoryTokenStore()
    let directory = DaemonDirectory(records: UserDefaultsRecordStore(suiteName: suite), tokens: tokens)
    let saved = try await directory.add(label: "s", address: DaemonAddress(host: "h"), token: "t")
    await directory.setActive(saved.id)

    let reloaded = DaemonDirectory(records: UserDefaultsRecordStore(suiteName: suite), tokens: tokens)
    #expect(await reloaded.all().map(\.label) == ["s"])
    #expect(await reloaded.activeID == saved.id)
}

@Test func emptyLabelFallsBackToTheHost() async throws {
    let directory = DaemonDirectory(
        records: UserDefaultsRecordStore(suiteName: "test-\(UUID().uuidString)"),
        tokens: InMemoryTokenStore())
    let saved = try await directory.add(label: "  ", address: DaemonAddress(host: "studio.local"), token: "t")
    #expect(saved.label == "studio.local")
}
