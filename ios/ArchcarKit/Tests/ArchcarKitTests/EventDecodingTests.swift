import Foundation
import Testing

@testable import ArchcarKit

private func event(_ json: String) throws -> ArchcarEvent {
    try JSONDecoder().decode(EventEnvelope.self, from: Data(json.utf8)).payload
}

@Test func decodesSessionStarted() throws {
    let decoded = try event(#"{"id":"e1","payload":{"type":"session_started","session_id":4,"thread_id":6,"workspace":"berlin","kind":"codex","pid":900}}"#)
    guard case .sessionStarted(let sessionID, let threadID, let workspace, let kind, let pid) = decoded else {
        Issue.record("expected session_started, got \(decoded)")
        return
    }
    #expect(sessionID == 4)
    #expect(threadID == 6)
    #expect(workspace == "berlin")
    #expect(kind == .codex)
    #expect(pid == 900)
}

@Test func decodesTurnCompletedWithoutStatus() throws {
    let decoded = try event(#"{"id":"e2","payload":{"type":"turn_completed","session_id":4,"thread_id":6}}"#)
    guard case .turnCompleted(let sessionID, let threadID, let status) = decoded else {
        Issue.record("expected turn_completed")
        return
    }
    #expect(sessionID == 4)
    #expect(threadID == 6)
    #expect(status == nil)
}

@Test func decodesInventoryChangedScope() throws {
    let decoded = try event(#"{"id":"e3","payload":{"type":"inventory_changed","scope":"workspace","workspace":"columbia"}}"#)
    guard case .inventoryChanged(let scope, let workspace, let repository) = decoded else {
        Issue.record("expected inventory_changed")
        return
    }
    #expect(scope == "workspace")
    #expect(workspace == "columbia")
    #expect(repository == nil)
}

@Test func decodesWorkspaceRenamed() throws {
    let decoded = try event(#"{"id":"e4","payload":{"type":"workspace_renamed","old_name":"placeholder","new_name":"ios-app"}}"#)
    guard case .workspaceRenamed(let old, let new) = decoded else {
        Issue.record("expected workspace_renamed")
        return
    }
    #expect(old == "placeholder")
    #expect(new == "ios-app")
}

@Test func keepsHeavyPayloadsAsRawJSON() throws {
    let decoded = try event(#"{"id":"e5","payload":{"type":"provider_interaction_requested","interaction":{"id":9,"kind":"permission"}}}"#)
    guard case .providerInteractionRequested(let raw) = decoded else {
        Issue.record("expected provider_interaction_requested")
        return
    }
    let object = try #require(try JSONSerialization.jsonObject(with: raw.data) as? [String: Any])
    #expect(object["id"] as? Int == 9)
}

@Test func unknownEventTypeDoesNotThrow() throws {
    let decoded = try event(#"{"id":"e6","payload":{"type":"some_future_event","x":1}}"#)
    guard case .unknown(let type) = decoded else {
        Issue.record("expected unknown")
        return
    }
    #expect(type == "some_future_event")
}

@Test func decodesEveryKnownEventName() throws {
    // Guards against a variant being added to the Rust enum and silently
    // landing in `.unknown` here forever.
    let names = [
        "session_spawn_queued", "session_started", "session_ready",
        "session_capabilities_changed", "turn_completed", "session_screen_updated",
        "session_messages_updated", "chat_queue_updated", "chat_plan_updated",
        "session_exited", "session_error", "provider_interaction_requested",
        "provider_interaction_resolved", "background_task_updated", "summary_updated",
        "task_updated", "workspace_renamed", "chat_thread_renamed", "inventory_changed"
    ]
    #expect(names.count == 19)
    #expect(Set(names) == ArchcarEvent.knownTypeNames)
}
