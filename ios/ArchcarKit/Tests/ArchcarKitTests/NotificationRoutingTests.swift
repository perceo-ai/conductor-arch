import Foundation
import Testing

@testable import ArchcarKit

private func workspace(id: Int64, name: String) throws -> WorkspaceSummary {
    let json = """
    {"id":\(id),"name":"\(name)","repository_name":"r","path":"/p/\(name)","branch":"b",
    "base_ref":"main","status":"active","open_todos":0,"blocked_tasks":0,
    "active_sessions":0,"awaiting_input":false,"run_running":false,"changed_files":0,
    "diff_additions":0,"diff_deletions":0,"updated_at":"1000"}
    """
    return try JSONDecoder().decode(WorkspaceSummary.self, from: Data(json.utf8))
}

private func thread(id: Int64, archived: Bool = false) throws -> ChatThread {
    let archivedAt = archived ? ",\"archived_at\":\"2000\"" : ""
    let json = """
    {"id":\(id),"provider":"claude","title":"t\(id)","status":"idle","updated_at":"1000"\(archivedAt)}
    """
    return try JSONDecoder().decode(ChatThread.self, from: Data(json.utf8))
}

private struct Fixture {
    let checkout: WorkspaceSummary
    let billing: WorkspaceSummary
    let chatThreads: [String: [ChatThread]]

    init() throws {
        checkout = try workspace(id: 1, name: "checkout")
        billing = try workspace(id: 2, name: "billing")
        chatThreads = [
            "checkout": [try thread(id: 41), try thread(id: 42)],
            "billing": [try thread(id: 7), try thread(id: 8, archived: true)],
        ]
    }

    var workspaces: [WorkspaceSummary] { [checkout, billing] }
}

@Test func tappedThreadResolvesToItsWorkspace() throws {
    let fixture = try Fixture()

    #expect(ChatThreadLookup.workspaceName(forThread: 42, in: fixture.chatThreads) == "checkout")
    #expect(ChatThreadLookup.workspaceName(forThread: 7, in: fixture.chatThreads) == "billing")
    #expect(ChatThreadLookup.resolve(
        threadID: 42, workspaces: fixture.workspaces, chatThreads: fixture.chatThreads)
        == .found(workspace: fixture.checkout, threadID: 42))
}

@Test func archivedThreadStillResolves() throws {
    let fixture = try Fixture()

    #expect(ChatThreadLookup.resolve(
        threadID: 8, workspaces: fixture.workspaces, chatThreads: fixture.chatThreads)
        == .found(workspace: fixture.billing, threadID: 8))
}

@Test func deletedThreadResolvesToNotFound() throws {
    let fixture = try Fixture()

    #expect(ChatThreadLookup.workspaceName(forThread: 999, in: fixture.chatThreads) == nil)
    #expect(ChatThreadLookup.resolve(
        threadID: 999, workspaces: fixture.workspaces, chatThreads: fixture.chatThreads)
        == .notFound(threadID: 999))
}

@Test func threadWhoseWorkspaceIsGoneResolvesToNotFound() throws {
    let fixture = try Fixture()

    // The snapshot still lists billing's chats, but billing itself is gone:
    // there is no workspace to open the chat in.
    #expect(ChatThreadLookup.resolve(
        threadID: 7, workspaces: [fixture.checkout], chatThreads: fixture.chatThreads)
        == .notFound(threadID: 7))
}

@Test func emptySnapshotResolvesToNotFound() {
    #expect(ChatThreadLookup.resolve(threadID: 42, workspaces: [], chatThreads: [:])
        == .notFound(threadID: 42))
}

@Test func threadIDIsReadFromEveryUserInfoShape() {
    // Local notification: AppModel stores an Int64.
    #expect(ChatThreadLookup.threadID(fromUserInfo: ["thread_id": Int64(42)]) == 42)
    // APNs: the payload is JSON, so the number arrives as an NSNumber.
    let pushed = try? JSONSerialization.jsonObject(
        with: Data(#"{"aps":{"alert":{"title":"t","body":"b"}},"thread_id":42}"#.utf8))
    #expect(ChatThreadLookup.threadID(fromUserInfo: pushed as? [AnyHashable: Any] ?? [:]) == 42)
    #expect(ChatThreadLookup.threadID(fromUserInfo: ["thread_id": NSNumber(value: 42)]) == 42)
    #expect(ChatThreadLookup.threadID(fromUserInfo: ["thread_id": 42]) == 42)
    #expect(ChatThreadLookup.threadID(fromUserInfo: ["thread_id": "42"]) == 42)
}

@Test func userInfoWithoutAThreadIsNotAChatTap() {
    #expect(ChatThreadLookup.threadID(fromUserInfo: [:]) == nil)
    #expect(ChatThreadLookup.threadID(fromUserInfo: ["thread_id": "not a number"]) == nil)
    #expect(ChatThreadLookup.threadID(fromUserInfo: ["thread_id": NSNumber(value: 1.5)]) == nil)
    #expect(ChatThreadLookup.threadID(fromUserInfo: ["other": 42]) == nil)
}
