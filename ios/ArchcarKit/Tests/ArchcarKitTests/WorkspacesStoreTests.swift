import Foundation
import Testing

@testable import ArchcarKit

private func summary(
    id: Int64 = 1, name: String = "w", status: String = "active", awaitingInput: Bool = false,
    blockedTasks: Int = 0, activeSessions: Int = 0, runRunning: Bool = false,
    changedFiles: Int = 0, prNumber: Int64? = nil, prState: String? = nil,
    updatedAt: String = "1000"
) throws -> WorkspaceSummary {
    let pr = (prState.map { "\"pull_request_state\":\"\($0)\"," } ?? "")
        + (prNumber.map { "\"pull_request_number\":\($0)," } ?? "")
    let json = """
    {"id":\(id),"name":"\(name)","repository_name":"r","path":"/p","branch":"b",
    "base_ref":"main","status":"\(status)","open_todos":0,"blocked_tasks":\(blockedTasks),
    "active_sessions":\(activeSessions),"awaiting_input":\(awaitingInput),
    "run_running":\(runRunning),"changed_files":\(changedFiles),"diff_additions":0,"diff_deletions":0,
    \(pr)"updated_at":"\(updatedAt)"}
    """
    return try JSONDecoder().decode(WorkspaceSummary.self, from: Data(json.utf8))
}

@Test func blockedTaskOutranksRunning() throws {
    let workspace = try summary(blockedTasks: 1, activeSessions: 2, runRunning: true)
    #expect(WorkspaceStatusKind.kind(for: workspace) == .blocked)
}

@Test func archivedOutranksEverything() throws {
    #expect(WorkspaceStatusKind.kind(for: try summary(status: "archived", blockedTasks: 3)) == .archived)
}

@Test func runningBeatsReview() throws {
    let workspace = try summary(activeSessions: 1, prNumber: 4, prState: "open")
    #expect(WorkspaceStatusKind.kind(for: workspace) == .running)
}

@Test func openPullRequestWithoutAgentsIsReview() throws {
    #expect(WorkspaceStatusKind.kind(for: try summary(prNumber: 4, prState: "open")) == .review)
}

@Test func uncommittedWorkIsChanges() throws {
    #expect(WorkspaceStatusKind.kind(for: try summary(changedFiles: 3)) == .changes)
}

@Test func quietWorkspaceIsIdle() throws {
    #expect(WorkspaceStatusKind.kind(for: try summary()) == .idle)
}

@Test func statusColoursMatchTheDesktopTable() {
    // Same hex values as desktop/src/lib/workspaceStatus.ts STATUS_COLOR.
    #expect(WorkspaceStatusKind.blocked.colorHex == "#d97706")
    #expect(WorkspaceStatusKind.running.colorHex == "#3fb27f")
    #expect(WorkspaceStatusKind.review.colorHex == "#5b8def")
    #expect(WorkspaceStatusKind.changes.colorHex == "#c39b50")
    #expect(WorkspaceStatusKind.idle.colorHex == "#6a6a6a")
    #expect(WorkspaceStatusKind.archived.colorHex == "#4a4a4a")
    #expect(WorkspaceStatusKind.review.label == "In review")
}

@Test func activityCountsAgentsAndRunScript() throws {
    #expect(WorkspaceActivity.activity(for: try summary()) == nil)
    let busy = try #require(WorkspaceActivity.activity(for: try summary(activeSessions: 2, runRunning: true)))
    #expect(busy.count == 3)
    #expect(busy.title == "2 agent sessions and run script running")
    let single = try #require(WorkspaceActivity.activity(for: try summary(activeSessions: 1)))
    #expect(single.title == "1 agent session running")
}

@Test func formatsEpochSecondStrings() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    // Typed `String` on the wire and epoch seconds in it, so a date parser
    // returns nothing useful — which is why this helper exists.
    #expect(RelativeTime.format(epochSecondsString: "999970", now: now) == "30s ago")
    #expect(RelativeTime.format(epochSecondsString: "999400", now: now) == "10m ago")
    #expect(RelativeTime.format(epochSecondsString: "996400", now: now) == "1h ago")
    #expect(RelativeTime.format(epochSecondsString: "not-a-number", now: now) == "—")
}

@Test func onlyRelevantEventsInvalidateTheList() {
    #expect(WorkspacesStore.invalidates(.inventoryChanged(scope: "workspace", workspace: "w", repository: nil)))
    #expect(WorkspacesStore.invalidates(.sessionStarted(sessionID: 1, threadID: 1, workspace: "w", kind: .codex, pid: 2)))
    #expect(WorkspacesStore.invalidates(.turnCompleted(sessionID: 1, threadID: 1, status: nil)))
    #expect(WorkspacesStore.invalidates(.workspaceRenamed(oldName: "a", newName: "b")))
    #expect(WorkspacesStore.invalidates(.taskUpdated(workspace: "w", taskID: 1, status: "blocked")))
    // Chat-level churn does not move the workspace list; refetching on it would
    // put a full inventory round-trip behind every streamed token.
    #expect(!WorkspacesStore.invalidates(.sessionScreenUpdated(sessionID: 1)))
    #expect(!WorkspacesStore.invalidates(.sessionMessagesUpdated(threadID: 1)))
    #expect(!WorkspacesStore.invalidates(.chatThreadRenamed(threadID: 1, title: "t")))
}

@MainActor
@Test func refreshLoadsInventoryFromTheDaemon() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { line in
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let id = object["id"] as? String,
              let payload = object["payload"] as? [String: Any],
              payload["type"] as? String == "get_inventory_snapshot" else { return nil }
        return """
        {"id":"\(id)","payload":{"type":"inventory_snapshot","repositories":[],\
        "workspaces":[{"id":3,"name":"columbia","repository_name":"conductor-arch",\
        "path":"/p","branch":"columbia","base_ref":"main","status":"active","open_todos":0,\
        "active_sessions":1,"run_running":false,"changed_files":2,"diff_additions":10,\
        "diff_deletions":1,"updated_at":"1000"}],"chat_threads":{}}}
        """
    }

    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = WorkspacesStore(session: session)
    await store.refresh()

    #expect(store.workspaces.map(\.name) == ["columbia"])
    #expect(store.isStale == false)
    #expect(store.lastError == nil)
    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func refreshFailureMarksStaleAndKeepsLastGoodData() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { line in
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let id = object["id"] as? String,
              let payload = object["payload"] as? [String: Any],
              payload["type"] as? String == "get_inventory_snapshot" else { return nil }
        return #"{"id":"\#(id)","payload":{"type":"inventory_snapshot","repositories":[],"workspaces":[],"chat_threads":{}}}"#
    }
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = WorkspacesStore(session: session)
    await store.refresh()
    #expect(store.isStale == false)

    await daemon.stop()
    await session.disconnect()
    await store.refresh()

    #expect(store.isStale)
    #expect(store.lastError != nil)
}
