import Foundation
import Testing

@testable import ArchcarKit

private func decodeObject(_ data: Data) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Test func unitRequestEncodesTypeTagOnly() throws {
    let line = try RequestEnvelope(id: "abc", body: ListWorkspacesRequest()).encodedLine()
    #expect(line.last == 0x0A)
    let object = try decodeObject(line)
    #expect(object["id"] as? String == "abc")
    let payload = try #require(object["payload"] as? [String: Any])
    #expect(payload["type"] as? String == "list_workspaces")
    #expect(payload.count == 1)
}

@Test func subscribeUsesItsWireName() throws {
    let line = try RequestEnvelope(id: "1", body: SubscribeRequest()).encodedLine()
    let payload = try #require(try decodeObject(line)["payload"] as? [String: Any])
    #expect(payload["type"] as? String == "subscribe")
}

@Test func inventorySnapshotUsesItsWireName() throws {
    let line = try RequestEnvelope(id: "1", body: GetInventorySnapshotRequest()).encodedLine()
    let payload = try #require(try decodeObject(line)["payload"] as? [String: Any])
    #expect(payload["type"] as? String == "get_inventory_snapshot")
}

@Test func notificationDeviceRegistrationUsesDaemonWireShape() throws {
    let line = try RequestEnvelope(
        id: "1",
        body: RegisterNotificationDeviceRequest(token: "abcd", appBundle: "ai.perceo.archductor.ios"))
        .encodedLine()
    let payload = try #require(try decodeObject(line)["payload"] as? [String: Any])
    #expect(payload["type"] as? String == "register_notification_device")
    #expect(payload["platform"] as? String == "ios")
    #expect(payload["token"] as? String == "abcd")
    #expect(payload["app_bundle"] as? String == "ai.perceo.archductor.ios")
}

@Test func encodedLineHasNoInteriorNewline() throws {
    let line = try RequestEnvelope(id: "1", body: GetRemoteAccessRequest()).encodedLine()
    #expect(line.dropLast().firstIndex(of: 0x0A) == nil)
}
