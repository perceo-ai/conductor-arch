import Foundation
import Testing

@testable import ArchcarKit

private func item(_ renderClass: String, stream: String = "complete", title: String = "")
    throws -> ProjectionItem
{
    let json = """
    {"id":"a","sequence":1,"render_class":"\(renderClass)","role_label":"r",
    "title":"\(title)","body":"b","status":"complete","stream_state":"\(stream)"}
    """
    return try JSONDecoder().decode(ProjectionItem.self, from: Data(json.utf8))
}

@Test func onlyAllowlistedClassesRender() throws {
    #expect(try ChatFormat.isDisplayable(item("user_chat")))
    #expect(try ChatFormat.isDisplayable(item("reasoning_card")))
    #expect(try ChatFormat.isDisplayable(item("command_card")))
    #expect(try ChatFormat.isDisplayable(item("diff_card")))
    // Hook cards are the ones a Claude session emits six of at startup; the
    // desktop drops them rather than showing raw events, so the phone must too.
    #expect(try ChatFormat.isDisplayable(item("hook_card")) == false)
    #expect(try ChatFormat.isDisplayable(item("mcp_card")) == false)
}

@Test func assistantTextRendersOnlyWhenFinalized() throws {
    // Partial markdown churns badly mid-stream, so the desktop waits for the
    // finalized item. Activity cards still render live.
    #expect(try ChatFormat.isDisplayable(item("assistant_chat", stream: "streaming")) == false)
    #expect(try ChatFormat.isDisplayable(item("assistant_chat", stream: "complete")))
    #expect(try ChatFormat.isDisplayable(item("command_card", stream: "streaming")))
}

@Test func cardsGetAVerbAndAChip() {
    let ran = ChatFormat.verbChip(renderClass: "command_card", title: "Ran cargo test")
    #expect(ran.verb == "Ran")
    #expect(ran.chip == "cargo test")

    // No leading verb: the class supplies one rather than doubling up.
    let tool = ChatFormat.verbChip(renderClass: "tool_card", title: "Grep")
    #expect(tool.verb == "Used")
    #expect(tool.chip == "Grep")

    let diff = ChatFormat.verbChip(renderClass: "diff_card", title: "src/main.rs")
    #expect(diff.verb == "Edited")
    #expect(diff.chip == "src/main.rs")

    let unknown = ChatFormat.verbChip(renderClass: "some_future_card", title: "whatever")
    #expect(unknown.verb == "Used")
}

@Test func filteringAWholeTranscriptKeepsTheConversation() throws {
    let items = [
        try item("user_chat"),
        try item("hook_card", title: "SessionStart:startup"),
        try item("hook_card", title: "SessionStart:startup"),
        try item("assistant_chat", stream: "streaming"),
        try item("command_card", title: "Ran ls"),
        try item("assistant_chat", stream: "complete"),
    ]
    let kept = items.filter(ChatFormat.isDisplayable)
    #expect(kept.map(\.renderClass) == ["user_chat", "command_card", "assistant_chat"])
}

@Test func hookFeedbackSurvivesTheFilterAsAHookRow() throws {
    // A blocking hook's explanation used to arrive as a user row. Core now
    // projects it onto its own class; dropping that class would lose the
    // hook's words from the phone entirely. The desktop renders it as an
    // inline event row (verb "Hook", title as chip, body on expand), so the
    // phone does the same rather than showing it as prose.
    let feedback = try item("hook_feedback_card", title: "Stop hook")
    #expect(ChatFormat.isDisplayable(feedback))
    #expect(feedback.presentation == .card)
    let label = ChatFormat.verbChip(renderClass: "hook_feedback_card", title: "Stop hook")
    #expect(label.verb == "Hook")
    #expect(label.chip == "Stop hook")

    let kept = [
        try item("user_chat"),
        try item("hook_card", title: "SessionStart:startup"),
        feedback,
    ].filter(ChatFormat.isDisplayable)
    #expect(kept.map(\.renderClass) == ["user_chat", "hook_feedback_card"])
}
