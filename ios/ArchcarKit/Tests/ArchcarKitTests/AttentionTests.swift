import Foundation
import Testing

@testable import ArchcarKit

private func decodeResponse(_ json: String) throws -> ArchcarResponse {
    try JSONDecoder().decode(ResponseEnvelope.self, from: Data(json.utf8)).payload
}

// Verbatim `archductor archcar attention --json` from a live daemon, wrapped in
// the response envelope. `thread_id`, `session_id` and `detail` are explicit
// nulls, not omitted, and the decoder has to take that.
private let liveQueue = """
{
  "generated_at": "2026-11-19T22:28:36Z",
  "items": [
    {
      "kind": "task_finished",
      "workspace": "smoke-task",
      "repository": "repo",
      "thread_id": null,
      "session_id": null,
      "headline": "Background task cancelled: Smoke task",
      "detail": null,
      "rank": 2
    }
  ]
}
"""

private func line(_ queue: String) -> String {
    #"{"id":"1","payload":{"type":"attention","queue":\#(queue)}}"#
}

@Test func attentionQueueDecodesFromDaemonJSON() throws {
    guard case .attention(let queue) = try decodeResponse(line(liveQueue)) else {
        Issue.record("expected .attention")
        return
    }
    #expect(queue.generatedAt == "2026-11-19T22:28:36Z")
    #expect(queue.items.count == 1)
    let item = queue.items[0]
    #expect(item.kind == .taskFinished)
    #expect(item.workspace == "smoke-task")
    #expect(item.repository == "repo")
    #expect(item.threadID == nil)
    #expect(item.sessionID == nil)
    #expect(item.headline == "Background task cancelled: Smoke task")
    #expect(item.detail == nil)
    #expect(item.rank == 2)
}

@Test func attentionItemsKeepDaemonOrder() throws {
    // Deliberately not rank-sorted: the daemon's order is the contract, and the
    // client must not re-sort.
    let json = """
    {"generated_at":"2026-11-19T00:00:00Z","items":[
    {"kind":"stalled","workspace":"b","repository":"r","thread_id":4,"session_id":9,"headline":"B","detail":"why","rank":1},
    {"kind":"agent_asked","workspace":"a","repository":"r","thread_id":null,"session_id":null,"headline":"A","detail":null,"rank":0},
    {"kind":"idle","workspace":"c","repository":"r","thread_id":null,"session_id":null,"headline":"C","detail":null,"rank":6}]}
    """
    guard case .attention(let queue) = try decodeResponse(line(json)) else {
        Issue.record("expected .attention")
        return
    }
    #expect(queue.items.map(\.headline) == ["B", "A", "C"])
    #expect(queue.items[0].threadID == 4)
    #expect(queue.items[0].sessionID == 9)
    #expect(queue.items[0].detail == "why")
}

@Test func attentionDecodesEveryKnownKind() throws {
    let kinds = ["agent_asked", "session_failed", "stalled", "task_finished",
                 "checks_failed", "review_comments", "diff_ready", "idle"]
    let items = kinds.map {
        #"{"kind":"\#($0)","workspace":"w","repository":"r","thread_id":null,"session_id":null,"headline":"h","detail":null,"rank":0}"#
    }.joined(separator: ",")
    guard case .attention(let queue) = try decodeResponse(
        line(#"{"generated_at":"x","items":[\#(items)]}"#)) else {
        Issue.record("expected .attention")
        return
    }
    #expect(queue.items.map(\.kind) == [
        .agentAsked, .sessionFailed, .stalled, .taskFinished,
        .checksFailed, .reviewComments, .diffReady, .idle,
    ])
}

@Test func attentionSurvivesAKindFromANewerDaemon() throws {
    let json = """
    {"generated_at":"2026-11-19T00:00:00Z","items":[
    {"kind":"quota_low","workspace":"w","repository":"r","thread_id":null,"session_id":null,"headline":"Quota low","detail":null,"rank":3},
    {"kind":"idle","workspace":"w","repository":"r","thread_id":null,"session_id":null,"headline":"Idle","detail":null,"rank":6}]}
    """
    guard case .attention(let queue) = try decodeResponse(line(json)) else {
        Issue.record("expected .attention")
        return
    }
    #expect(queue.items.count == 2)
    #expect(queue.items[0].kind == .unknown("quota_low"))
    #expect(queue.items[0].headline == "Quota low")
    #expect(queue.items[1].kind == .idle)
}

@Test func encodesListAttentionRequest() throws {
    let data = try RequestEnvelope(id: "1", body: ListAttentionRequest()).encodedLine()
    let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let payload = try #require(object["payload"] as? [String: Any])
    #expect(payload["type"] as? String == "list_attention")
}

@Test func attentionTiersMatchTheDesktopCutPoints() {
    #expect(AttentionTier.of(rank: 0) == .needsYouNow)
    #expect(AttentionTier.of(rank: 1) == .needsYouNow)
    #expect(AttentionTier.of(rank: 2) == .worthALook)
    #expect(AttentionTier.of(rank: 4) == .worthALook)
    #expect(AttentionTier.of(rank: 5) == .whenYouHaveAMoment)
    #expect(AttentionTier.of(rank: 6) == .whenYouHaveAMoment)
    #expect(AttentionTier.needsYouNow.title == "Needs you now")
    #expect(AttentionTier.worthALook.title == "Worth a look")
    #expect(AttentionTier.whenYouHaveAMoment.title == "When you have a moment")
}

@Test func attentionSectionsAreContiguousRunsOfTheDaemonOrder() throws {
    func item(_ headline: String, _ rank: Int) -> AttentionItem {
        AttentionItem(kind: .idle, workspace: "w", repository: "r", threadID: nil,
                      sessionID: nil, headline: headline, detail: nil, rank: rank)
    }
    let sections = AttentionTier.sections(of: [item("a", 0), item("b", 1), item("c", 3), item("d", 6)])
    #expect(sections.map(\.tier) == [.needsYouNow, .worthALook, .whenYouHaveAMoment])
    #expect(sections.map { $0.items.map(\.headline) } == [["a", "b"], ["c"], ["d"]])
}

@Test func attentionGeneratedAtParsesRFC3339() throws {
    let queue = AttentionQueue(generatedAt: "2026-11-19T22:28:36Z", items: [])
    #expect(queue.generatedDate == Date(timeIntervalSince1970: 1_795_127_316))
    #expect(AttentionQueue(generatedAt: "garbage", items: []).generatedDate == nil)
}
