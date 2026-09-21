import Foundation
import Testing

@testable import ArchcarKit

private func summary(
    id: Int64 = 1, name: String = "w", awaitingInput: Bool = false,
    blockedTasks: Int = 0, activeSessions: Int = 0, runRunning: Bool = false,
    prState: String? = nil, updatedAt: String = "1000"
) throws -> WorkspaceSummary {
    let pr = prState.map { "\"pull_request_state\":\"\($0)\"," } ?? ""
    let json = """
    {"id":\(id),"name":"\(name)","repository_name":"r","path":"/p","branch":"b",
    "base_ref":"main","status":"active","open_todos":0,"blocked_tasks":\(blockedTasks),
    "active_sessions":\(activeSessions),"awaiting_input":\(awaitingInput),
    "run_running":\(runRunning),"changed_files":0,"diff_additions":0,"diff_deletions":0,
    \(pr)"updated_at":"\(updatedAt)"}
    """
    return try JSONDecoder().decode(WorkspaceSummary.self, from: Data(json.utf8))
}

@Test func blockedOutranksRunning() throws {
    let workspace = try summary(awaitingInput: true, activeSessions: 2)
    #expect(WorkspaceStatusDot.dot(for: workspace) == .blocked)
}

@Test func blockedTasksAlsoMeanBlocked() throws {
    #expect(WorkspaceStatusDot.dot(for: try summary(blockedTasks: 1)) == .blocked)
}

@Test func runningBeatsReview() throws {
    let workspace = try summary(activeSessions: 1, prState: "open")
    #expect(WorkspaceStatusDot.dot(for: workspace) == .running)
}

@Test func openPullRequestWithoutAgentsIsReview() throws {
    #expect(WorkspaceStatusDot.dot(for: try summary(prState: "open")) == .review)
}

@Test func quietWorkspaceIsIdle() throws {
    #expect(WorkspaceStatusDot.dot(for: try summary()) == .idle)
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
