import Foundation
import Testing

@testable import ArchcarKit

private func decode(_ json: String) throws -> ResponseEnvelope {
    try JSONDecoder().decode(ResponseEnvelope.self, from: Data(json.utf8))
}

// Field-for-field as the daemon sends it, so a rename in
// ArchcarWorkspaceSummary fails here rather than silently emptying the UI.
private let workspacesLine = """
{"id":"1","payload":{"type":"workspaces","workspaces":[{"id":7,"name":"columbia",\
"repository_name":"conductor-arch","path":"/w/columbia","branch":"columbia",\
"base_ref":"main","status":"active","open_todos":2,"open_tasks":1,"blocked_tasks":1,\
"active_sessions":2,"awaiting_input":true,"run_running":false,"changed_files":4,\
"diff_additions":128,"diff_deletions":37,"pull_request_number":121,\
"pull_request_state":"open","pull_request_url":"https://example.invalid/pr/121",\
"branch_ahead":3,"branch_behind":0,"updated_at":"1758326400"}]}}
"""

@Test func decodesWorkspaceSummary() throws {
    let envelope = try decode(workspacesLine)
    #expect(envelope.id == "1")
    guard case .workspaces(let workspaces) = envelope.payload else {
        Issue.record("expected workspaces, got \(envelope.payload)")
        return
    }
    let workspace = try #require(workspaces.first)
    #expect(workspace.id == 7)
    #expect(workspace.name == "columbia")
    #expect(workspace.blockedTasks == 1)
    #expect(workspace.awaitingInput)
    #expect(workspace.pullRequestNumber == 121)
    #expect(workspace.updatedAt == "1758326400")
}

@Test func optionalWorkspaceFieldsMayBeAbsent() throws {
    let line = """
    {"id":"1","payload":{"type":"workspaces","workspaces":[{"id":1,"name":"x",\
    "repository_name":"r","path":"/p","branch":"b","base_ref":"main","status":"active",\
    "open_todos":0,"active_sessions":0,"run_running":false,"changed_files":0,\
    "diff_additions":0,"diff_deletions":0,"updated_at":"1"}]}}
    """
    guard case .workspaces(let workspaces) = try decode(line).payload else {
        Issue.record("expected workspaces")
        return
    }
    let workspace = try #require(workspaces.first)
    #expect(workspace.openTasks == 0)
    #expect(workspace.blockedTasks == 0)
    #expect(workspace.awaitingInput == false)
    #expect(workspace.pullRequestNumber == nil)
}

@Test func decodesInventorySnapshot() throws {
    let line = """
    {"id":"2","payload":{"type":"inventory_snapshot","repositories":[{"id":1,\
    "name":"conductor-arch","root_path":"/src","default_branch":"main",\
    "remote_name":"origin","active_workspaces":3,"total_workspaces":9}],\
    "workspaces":[],"chat_threads":{}}}
    """
    guard case .inventorySnapshot(let repositories, let workspaces) = try decode(line).payload else {
        Issue.record("expected inventory_snapshot")
        return
    }
    #expect(workspaces.isEmpty)
    #expect(repositories.first?.activeWorkspaces == 3)
    #expect(repositories.first?.remoteURL == nil)
}

@Test func decodesErrorPayload() throws {
    let line = #"{"id":"auth","payload":{"type":"error","message":"archcar authentication failed"}}"#
    guard case .error(let message) = try decode(line).payload else {
        Issue.record("expected error")
        return
    }
    #expect(message == "archcar authentication failed")
}

@Test func unknownResponseTypeDoesNotThrow() throws {
    let line = #"{"id":"3","payload":{"type":"some_future_response","whatever":[1,2,3]}}"#
    guard case .unknown(let type) = try decode(line).payload else {
        Issue.record("expected unknown")
        return
    }
    #expect(type == "some_future_response")
}

@Test func sessionKindAcceptsUnlistedProviders() throws {
    let kind = try JSONDecoder().decode(SessionKind.self, from: Data("\"amp\"".utf8))
    #expect(kind.rawValue == "amp")
    #expect(kind != .codex)
}
