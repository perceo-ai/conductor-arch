import Foundation
import Testing

@testable import ArchcarKit

private func item(_ renderClass: String, role: String = "assistant", title: String = "t") throws
    -> ProjectionItem
{
    let json = """
    {"id":"a","sequence":1,"render_class":"\(renderClass)","role_label":"\(role)",
    "title":"\(title)","body":"b","status":"complete","stream_state":"final"}
    """
    return try JSONDecoder().decode(ProjectionItem.self, from: Data(json.utf8))
}

@Test func chatBubblesAreTheirOwnPresentation() throws {
    #expect(try item("user_chat", role: "user").presentation == .userMessage)
    #expect(try item("assistant_chat").presentation == .assistantMessage)
}

@Test func everythingElseIsACard() throws {
    #expect(try item("command_card").presentation == .card)
    #expect(try item("diff_card").presentation == .card)
    #expect(try item("reasoning_card").presentation == .card)
    // Core grows render classes as providers grow features; an unrecognised one
    // must still render as something rather than vanish from the transcript.
    #expect(try item("some_future_card").presentation == .card)
}

@Test func cardIconsCoverTheClassesCoreEmits() throws {
    // Not exhaustive by design — the fallback is the point — but the common
    // ones should not all collapse to the same glyph.
    let icons = Set(
        try ["command_card", "diff_card", "file_card", "reasoning_card", "error_card", "plan_card"]
            .map { try item($0).symbolName })
    #expect(icons.count >= 5)
    #expect(try item("error_card").symbolName == "exclamationmark.triangle")
}

@Test func inventorySnapshotCarriesChatThreadsPerWorkspace() throws {
    let json = """
    {"id":"1","payload":{"type":"inventory_snapshot","repositories":[],"workspaces":[],
    "chat_threads":{"columbia":[{"id":7,"provider":"codex","title":"Fix auth",
    "status":"open","updated_at":"2"}]}}}
    """
    let payload = try JSONDecoder().decode(ResponseEnvelope.self, from: Data(json.utf8)).payload
    guard case .inventorySnapshot(_, _, let chatThreads) = payload else {
        Issue.record("expected inventory_snapshot")
        return
    }
    #expect(chatThreads["columbia"]?.map(\.title) == ["Fix auth"])
}
