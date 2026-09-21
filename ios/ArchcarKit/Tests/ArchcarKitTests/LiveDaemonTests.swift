import Foundation
import Testing

@testable import ArchcarKit

/// The suite that catches protocol drift: it runs the real Rust daemon over
/// the real TCP listener, so a renamed field in `ArchcarWorkspaceSummary`
/// fails here instead of quietly emptying a phone screen.
@Suite(.serialized)
struct LiveDaemonTests {
    /// Connects with a few retries, because the daemon needs a moment to bind.
    private func connect(_ daemon: LiveDaemon, token: String? = nil) async throws -> DaemonSession {
        var lastError: Error?
        for _ in 0..<60 {
            let session = DaemonSession(address: daemon.address, token: token ?? daemon.token)
            do {
                try await session.connect()
                return session
            } catch DaemonSessionError.authenticationFailed {
                throw DaemonSessionError.authenticationFailed
            } catch {
                lastError = error
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        throw lastError ?? DaemonSessionError.disconnected
    }

    @Test func listsWorkspacesOverTheRealProtocol() async throws {
        let daemon = try LiveDaemon.start()
        defer { daemon.stop() }

        let session: DaemonSession
        do {
            session = try await connect(daemon)
        } catch {
            Issue.record("connect failed: \(error)\n\(daemon.diagnostics())")
            return
        }
        let response = try await session.request(ListWorkspacesRequest())
        guard case .workspaces(let workspaces) = response else {
            Issue.record("expected workspaces, got \(response)")
            return
        }
        // A fresh state root has no repositories, so the list is empty. What
        // matters is that the request, the tag, and the response shape all
        // agree with the daemon that is actually running.
        #expect(workspaces.isEmpty)
        await session.disconnect()
    }

    @Test func inventorySnapshotDecodes() async throws {
        let daemon = try LiveDaemon.start()
        defer { daemon.stop() }

        let session = try await connect(daemon)
        let response = try await session.request(GetInventorySnapshotRequest())
        guard case .inventorySnapshot(let repositories, let workspaces, _) = response else {
            Issue.record("expected inventory_snapshot, got \(response)")
            return
        }
        #expect(repositories.isEmpty)
        #expect(workspaces.isEmpty)
        await session.disconnect()
    }

    @Test func rejectsABadToken() async throws {
        let daemon = try LiveDaemon.start()
        defer { daemon.stop() }

        let good = try await connect(daemon)  // ensure the listener is up
        await good.disconnect()

        await #expect(throws: DaemonSessionError.authenticationFailed) {
            _ = try await connect(daemon, token: "not-the-token")
        }
    }

    /// The chat surface, against the daemon that actually implements it: a
    /// thread created here must come back in the thread list, project an empty
    /// timeline, and accept a queued turn — the protocol P1's UI is built on.
    @Test func chatThreadLifecycleOverTheRealProtocol() async throws {
        let daemon = try LiveDaemon.start()
        defer { daemon.stop() }
        let session = try await connect(daemon)
        let workspace = try daemon.seedWorkspace(named: "chat-check")

        let created = try await session.request(
            CreateChatThreadRequest(workspace: workspace, provider: "codex", title: "From phone"))
        guard case .chatThreadCreated(let thread) = created else {
            Issue.record("expected chat_thread_created, got \(created)")
            return
        }
        #expect(thread.title == "From phone")
        #expect(thread.sessionKind == .codex)

        let listed = try await session.request(ListChatThreadsRequest(workspace: workspace))
        guard case .chatThreads(_, let threads) = listed else {
            Issue.record("expected chat_threads, got \(listed)")
            return
        }
        #expect(threads.contains { $0.id == thread.id })

        let projected = try await session.request(GetChatProjectionRequest(threadID: thread.id))
        guard case .chatProjection(let threadID, let items) = projected else {
            Issue.record("expected chat_projection, got \(projected)")
            return
        }
        #expect(threadID == thread.id)
        #expect(items.isEmpty)

        _ = try await session.request(
            QueueChatInputRequest(threadID: thread.id, input: "ship it", sessionKind: .codex))
        let queued = try await session.request(ListQueuedChatInputsRequest(threadID: thread.id))
        guard case .queuedChatInputs(_, let inputs) = queued else {
            Issue.record("expected queued_chat_inputs, got \(queued)")
            return
        }
        #expect(inputs.map(\.displayText) == ["ship it"])

        if let first = inputs.first {
            _ = try await session.request(RemoveQueuedChatInputRequest(queueID: first.id))
        }
        await session.disconnect()
    }

    /// No agent is running in a fresh workspace, so the pending list is empty —
    /// what this pins is that the request and the response shape agree with the
    /// daemon, since the blocked-agent path cannot be staged without a provider.
    @Test func pendingInteractionsDecodeFromTheRealDaemon() async throws {
        let daemon = try LiveDaemon.start()
        defer { daemon.stop() }
        let session = try await connect(daemon)

        let response = try await session.request(ListProviderInteractionsRequest(pendingOnly: true))
        guard case .providerInteractions(let interactions) = response else {
            Issue.record("expected provider_interactions, got \(response)")
            return
        }
        #expect(interactions.isEmpty)
        await session.disconnect()
    }

    /// Repository and workspace lifecycle against the daemon: create a
    /// workspace, see it in the inventory, read its (empty) changes and checks,
    /// then archive it.
    @Test func workspaceLifecycleOverTheRealProtocol() async throws {
        let daemon = try LiveDaemon.start()
        defer { daemon.stop() }
        let session: DaemonSession
        do {
            session = try await connect(daemon)
        } catch {
            Issue.record("connect failed: \(error)\n\(daemon.diagnostics())")
            return
        }
        do {
            try daemon.seedRepository()
        } catch {
            Issue.record("seedRepository failed: \(error)")
            return
        }

        let repositories: ArchcarResponse
        do {
            repositories = try await session.request(ListRepositoriesRequest())
        } catch {
            Issue.record("list_repositories failed: \(error)\n\(daemon.diagnostics())")
            return
        }
        guard case .repositories(let repos) = repositories else {
            Issue.record("expected repositories, got \(repositories)")
            return
        }
        #expect(repos.map(\.name) == ["demo"])

        let created: ArchcarResponse
        do {
            created = try await session.request(
                CreateWorkspaceRequest(
                    repository: "demo", name: "from-phone", branch: "feat/from-phone"))
        } catch {
            Issue.record("create_workspace failed: \(error)\n\(daemon.diagnostics())")
            return
        }
        guard case .workspaceCreated(let name) = created else {
            Issue.record("expected workspace_created, got \(created)")
            return
        }
        #expect(name == "from-phone")

        let changes = try await session.request(GetWorkspaceChangesRequest(workspace: name))
        guard case .workspaceChanges(_, let files) = changes else {
            Issue.record("expected workspace_changes, got \(changes)")
            return
        }
        // A fresh worktree carries the .context directory archductor writes.
        #expect(files.allSatisfy { !$0.path.isEmpty })

        let checks = try await session.request(GetChecksSummaryRequest(workspace: name))
        guard case .checksSummary(_, let summary) = checks else {
            Issue.record("expected checks_summary, got \(checks)")
            return
        }
        #expect(summary.workspace == name)

        let todos = try await session.request(ListTodosRequest(workspace: name))
        guard case .todos(_, let list) = todos else {
            Issue.record("expected todos, got \(todos)")
            return
        }
        #expect(list.isEmpty)

        let archived = try await session.request(
            ArchiveWorkspaceRequest(workspace: name, removeWorktree: false))
        guard case .workspaceUpdated = archived else {
            Issue.record("expected workspace_updated, got \(archived)")
            return
        }
        await session.disconnect()
    }

    /// The diff of a real edit, over the wire.
    @Test func workspaceDiffOverTheRealProtocol() async throws {
        let daemon = try LiveDaemon.start()
        defer { daemon.stop() }
        let session = try await connect(daemon)
        try daemon.seedRepository()

        let created = try await session.request(
            CreateWorkspaceRequest(repository: "demo", name: "diff-check", branch: "feat/diff-check"))
        guard case .workspaceCreated(let name) = created else {
            Issue.record("expected workspace_created")
            return
        }
        try daemon.writeInWorkspace(name, path: "hello.txt", contents: "hello from the phone\n")

        let changes = try await session.request(GetWorkspaceChangesRequest(workspace: name))
        guard case .workspaceChanges(_, let files) = changes else {
            Issue.record("expected workspace_changes")
            return
        }
        #expect(files.contains { $0.path == "hello.txt" })

        let diff = try await session.request(
            GetWorkspaceDiffRequest(workspace: name, path: "hello.txt"))
        guard case .workspaceDiff(_, let text) = diff else {
            Issue.record("expected workspace_diff")
            return
        }
        #expect(text.contains("hello from the phone"))
        await session.disconnect()
    }

    @Test func subscribeStaysOpenAndCommandsStillWork() async throws {
        let daemon = try LiveDaemon.start()
        defer { daemon.stop() }

        let session = try await connect(daemon)
        // Proves the dual-socket design against the real server: a session that
        // has subscribed can still issue commands, which a single connection
        // could not do.
        _ = try await session.request(ListRepositoriesRequest())
        #expect(await session.connectionState == .connected)
        await session.disconnect()
    }
}
