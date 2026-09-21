import Foundation
import Testing

@testable import ArchcarKit

private func requestType(_ line: String) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          let payload = object["payload"] as? [String: Any] else { return nil }
    return payload["type"] as? String
}

private func replyID(_ line: String) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
    else { return nil }
    return object["id"] as? String
}

private let inventory = """
{"type":"inventory_snapshot","repositories":[{"id":1,"name":"demo","root_path":"/r",\
"default_branch":"main","remote_name":"origin","active_workspaces":1,"total_workspaces":1}],\
"workspaces":[{"id":7,"name":"fix-auth","repository_name":"demo","path":"/p","branch":"b",\
"base_ref":"main","status":"active","open_todos":0,"active_sessions":0,"run_running":false,\
"changed_files":0,"diff_additions":0,"diff_deletions":0,"updated_at":"2"},\
{"id":8,"name":"orphan","repository_name":"gone","path":"/p","branch":"b","base_ref":"main",\
"status":"active","open_todos":0,"active_sessions":0,"run_running":false,"changed_files":0,\
"diff_additions":0,"diff_deletions":0,"updated_at":"1"}],"chat_threads":{}}
"""

private let responder: @Sendable (String) -> String? = { line in
    guard let id = replyID(line), let type = requestType(line) else { return nil }
    switch type {
    case "get_inventory_snapshot":
        return #"{"id":"\#(id)","payload":\#(inventory)}"#
    case "create_workspace", "create_workspace_from_prompt", "create_workspace_from_issue":
        return #"{"id":"\#(id)","payload":{"type":"workspace_created","name":"made-it"}}"#
    case "archive_workspace", "restore_workspace", "rename_workspace":
        return #"{"id":"\#(id)","payload":{"type":"workspace_updated","name":"fix-auth"}}"#
    case "add_repository", "clone_repository":
        return #"{"id":"\#(id)","payload":{"type":"repository_added","name":"demo"}}"#
    case "list_repositories":
        return #"{"id":"\#(id)","payload":{"type":"repositories","repositories":[]}}"#
    default:
        return nil
    }
}

@MainActor
private func store(_ daemon: MockDaemon) async throws -> (DaemonSession, WorkspacesStore) {
    await daemon.respond(to: responder)
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = WorkspacesStore(session: session)
    await store.refresh()
    return (session, store)
}

@MainActor
@Test func groupsWorkspacesByRepository() async throws {
    let daemon = try await MockDaemon()
    let (session, workspaces) = try await store(daemon)

    #expect(workspaces.groups.map(\.repository.name) == ["demo"])
    #expect(workspaces.groups.first?.workspaces.map(\.name) == ["fix-auth"])
    // A workspace whose repository is missing from the inventory would vanish
    // from a grouped list; it gets its own bucket instead.
    #expect(workspaces.orphanedWorkspaces.map(\.name) == ["orphan"])

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func createsAWorkspaceFromABranch() async throws {
    let daemon = try await MockDaemon()
    let (session, workspaces) = try await store(daemon)

    let name = await workspaces.createWorkspace(
        in: "demo", .branch(name: "fix-auth", branch: "fix/auth", baseRef: nil))

    #expect(name == "made-it")
    let sent = await daemon.receivedLines.compactMap(requestType)
    #expect(sent.contains("create_workspace"))
    // The list is refetched rather than patched, so a daemon-side rename or
    // branch adjustment shows up immediately.
    #expect(sent.filter { $0 == "get_inventory_snapshot" }.count >= 2)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func createsAWorkspaceFromAPrompt() async throws {
    let daemon = try await MockDaemon()
    let (session, workspaces) = try await store(daemon)

    _ = await workspaces.createWorkspace(in: "demo", .prompt("make login work"))

    let sent = await daemon.receivedLines.compactMap(requestType)
    #expect(sent.contains("create_workspace_from_prompt"))
    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func archivesAndRestores() async throws {
    let daemon = try await MockDaemon()
    let (session, workspaces) = try await store(daemon)
    let workspace = try #require(workspaces.workspaces.first)

    await workspaces.archive(workspace, removeWorktree: false)
    await workspaces.restore(workspace)

    let sent = await daemon.receivedLines.compactMap(requestType)
    #expect(sent.contains("archive_workspace"))
    #expect(sent.contains("restore_workspace"))
    #expect(workspaces.isMutating == false)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func addsARepository() async throws {
    let daemon = try await MockDaemon()
    let (session, workspaces) = try await store(daemon)

    #expect(await workspaces.addRepository(path: "/src/demo", name: "demo"))
    let sent = await daemon.receivedLines.compactMap(requestType)
    #expect(sent.contains("add_repository"))

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func archiveReportsDaemonRejection() async throws {
    let daemon = try await MockDaemon()
    // The daemon refuses — a dirty worktree, a missing branch, anything.
    await daemon.respond { line in
        guard let id = replyID(line), let type = requestType(line) else { return nil }
        if type == "get_inventory_snapshot" {
            return #"{"id":"\#(id)","payload":\#(inventory)}"#
        }
        if type == "list_repositories" {
            return #"{"id":"\#(id)","payload":{"type":"repositories","repositories":[]}}"#
        }
        if type == "archive_workspace" {
            return #"{"id":"\#(id)","payload":{"type":"error","message":"worktree has changes"}}"#
        }
        return nil
    }
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = WorkspacesStore(session: session)
    await store.refresh()
    let workspace = try #require(store.workspaces.first)

    let ok = await store.archive(workspace, removeWorktree: false)

    // Refreshing on failure would clear the error and leave the row unchanged
    // with nothing to explain it.
    #expect(ok == false)
    #expect(store.lastError?.contains("worktree has changes") == true)

    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func archiveSucceedsAndClearsTheError() async throws {
    let daemon = try await MockDaemon()
    let (session, workspaces) = try await store(daemon)
    let workspace = try #require(workspaces.workspaces.first)

    #expect(await workspaces.archive(workspace, removeWorktree: false))
    #expect(workspaces.lastError == nil)

    await session.disconnect()
    await daemon.stop()
}
