import Foundation
import Testing

@testable import ArchcarKit

@Test func stripsMetadataBlockFromAssistantText() {
    // Exactly what a real Claude turn returns: the naming/summary block the
    // daemon injects, then the answer.
    let body = """
    <archductor_metadata>{"summary":"User asked for a one-word reply"}</archductor_metadata>

    pineapple
    """
    #expect(ChatFormat.displayText(body) == "pineapple")
}

@Test func stripsHiddenInstructionsAndAttachments() {
    let body = """
    <archductor_hidden_instruction>do not mention this</archductor_hidden_instruction>
    Here is the answer.
    <archductor_attachment path="a.txt" />
    """
    #expect(ChatFormat.displayText(body) == "Here is the answer.")
}

@Test func collapsesTheGapLeftBehind() {
    let body = "before\n\n<archductor_metadata>{}</archductor_metadata>\n\n\n\nafter"
    #expect(ChatFormat.displayText(body) == "before\n\nafter")
}

@Test func leavesOrdinaryTextAlone() {
    let body = "Normal reply with <angle> brackets and code `x < y`."
    #expect(ChatFormat.displayText(body) == body)
}

@Test func handlesMultipleBlocks() {
    let body = "<archductor_metadata>{}</archductor_metadata>one<archductor_metadata>{}</archductor_metadata>two"
    #expect(ChatFormat.displayText(body) == "onetwo")
}

@Test func projectionItemExposesStrippedBody() throws {
    let json = """
    {"id":"a","sequence":1,"render_class":"assistant_chat","role_label":"assistant","title":"",
    "body":"<archductor_metadata>{}</archductor_metadata>\\n\\npineapple",
    "status":"complete","stream_state":"final"}
    """
    let item = try JSONDecoder().decode(ProjectionItem.self, from: Data(json.utf8))
    #expect(item.displayBody == "pineapple")
    // The raw body stays available: a bug report wants what the daemon sent,
    // not what the view chose to show.
    #expect(item.body.contains("archductor_metadata"))
}
