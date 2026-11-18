import Foundation
import Testing

@testable import ArchcarKit

/// The phone's port of workspace transfer, driven against two scripted
/// daemons. Scenarios mirror `transferWorkspace` in desktop/src/store/actions.test.ts.
private actor TwoDaemons {
    var order: [String] = []
    // Source state
    var liveSession = false
    var archivedSource = false
    // Target state
    var targetWorkspace: (status: String, head: String)?
    var restorable = true
    var delivered = false
    var sameIdentity = false
    /// The target's existing chat holds an older conversation, not a seeded
    /// copy of this transfer's transcript.
    var staleChat = false
    var seededTranscript: Int?
    var queuedThread: Int64?

    let pushed = "abc1234def"

    func configure(_ change: @Sendable (isolated TwoDaemons) -> Void) { change(self) }

    func source(_ type: String, _ fields: [String: JSONValue]) -> JSONValue {
        order.append("src:\(type)")
        switch type {
        case "get_remote_access":
            return .object(["type": "remote_access", "token": "tok-src", "token_path": "/src"])
        case "list_workspaces":
            return .object(["type": "workspaces", "workspaces": .array([.object([
                "name": "parser", "repository_name": "app", "branch": "lc/parser",
                "base_ref": "main", "status": "active",
            ])])])
        case "list_repositories":
            return .object(["type": "repositories", "repositories": .array([.object([
                "name": "app", "remote_url": "git@github.com:me/app.git",
            ])])])
        case "list_chat_threads":
            return .object(["type": "chat_threads", "workspace": "parser", "threads": .array([.object([
                "id": 5, "provider": "codex", "title": "Parser port", "updated_at": "9",
            ])])])
        case "get_chat_snapshot":
            let session: JSONValue = liveSession
                ? .object(["session_id": 42, "status": "running", "runtime_state": "running", "ready": true])
                : .null
            return .object(["type": "chat_snapshot", "snapshot": .object([
                "thread_id": 5, "messages": .array([]), "live_session": session,
            ])])
        case "kill_session":
            liveSession = false
            return .object(["type": "ack"])
        case "get_session_status":
            return .object(["type": "session_status", "session_id": 42, "status": "exited", "runtime_state": "exited", "ready": false])
        case "get_chat_transcript":
            return .object(["type": "chat_transcript", "thread_id": 5, "title": "Parser port", "messages": .array([
                .object(["role": "user", "content": "port the parser", "created_at": "1"]),
            ])])
        case "get_workspace_changes":
            return .object(["type": "workspace_changes", "workspace": "parser", "files": .array([])])
        case "commit_workspace_changes":
            return .object(["type": "error", "message": "stage at least one file before committing"])
        case "push_branch":
            return .object(["type": "ack"])
        case "get_recent_commits":
            return .object(["type": "recent_commits", "workspace": "parser", "log": .string("\(pushed) msg")])
        case "archive_workspace":
            archivedSource = true
            return .object(["type": "workspace_updated", "name": "parser"])
        default:
            return .object(["type": "error", "message": .string("unscripted \(type)")])
        }
    }

    func target(_ type: String, _ fields: [String: JSONValue]) -> JSONValue {
        order.append("dst:\(type)")
        switch type {
        case "get_remote_access":
            return .object(["type": "remote_access", "token": sameIdentity ? "tok-src" : "tok-dst",
                            "token_path": sameIdentity ? "/src" : "/dst"])
        case "list_repositories":
            return .object(["type": "repositories", "repositories": .array([.object([
                "name": "app-here", "remote_url": "https://github.com/me/app",
            ])])])
        case "list_workspaces":
            guard let ws = targetWorkspace else { return .object(["type": "workspaces", "workspaces": .array([])]) }
            return .object(["type": "workspaces", "workspaces": .array([.object([
                "name": "parser", "repository_name": "app-here", "branch": "lc/parser",
                "status": .string(ws.status),
            ])])])
        case "restore_workspace":
            if restorable, let ws = targetWorkspace { targetWorkspace = ("active", ws.head) }
            return .object(["type": "workspace_updated", "name": "parser"])
        case "close_chat_thread":
            return .object(["type": "ack"])
        case "seed_chat_thread":
            seededTranscript = fields["transcript"]?.array.count
            return .object(["type": "chat_thread_created", "thread": .object([
                "id": 12, "provider": "codex", "title": "Parser port", "status": "open", "updated_at": "10",
            ])])
        case "get_recent_commits":
            return .object(["type": "recent_commits", "workspace": "parser",
                            "log": .string("\(targetWorkspace?.head ?? pushed) msg")])
        case "import_workspace_from_remote":
            targetWorkspace = ("active", pushed)
            return .object(["type": "workspace_imported", "workspace": "parser", "repository": "app-here",
                            "branch": "lc/parser", "thread_id": 11, "copied_messages": 1])
        case "list_chat_threads":
            return .object(["type": "chat_threads", "workspace": "parser", "threads": .array([.object([
                "id": 11, "provider": "codex", "title": "Parser port", "updated_at": "9",
            ])])])
        case "get_chat_snapshot":
            var rows: [JSONValue] = []
            if !staleChat {
                // What an import seeds: the source transcript, verbatim.
                rows.append(.object(["role": "user", "source": "fork", "content": "port the parser"]))
            }
            if delivered {
                rows.append(.object(["role": "user", "source": "user",
                                     "content": .string("\(WorkspaceTransfer.preamblePrefix)A to B")]))
            }
            let messages: JSONValue = .array(rows)
            return .object(["type": "chat_snapshot", "snapshot": .object(["thread_id": 11, "messages": messages])])
        case "ensure_chat_thread_session":
            return .object(["type": "session_spawn_queued", "workspace": "parser", "kind": "codex"])
        case "queue_chat_input":
            queuedThread = fields["thread_id"]?.int
            delivered = true
            return .object(["type": "queued_chat_input"])
        default:
            return .object(["type": "error", "message": .string("unscripted \(type)")])
        }
    }
}

private func endpoints(_ daemons: TwoDaemons) -> (WorkspaceTransfer.Endpoint, WorkspaceTransfer.Endpoint) {
    (
        WorkspaceTransfer.Endpoint(label: "perceo-control") { type, fields in await daemons.source(type, fields) },
        WorkspaceTransfer.Endpoint(label: "macbook") { type, fields in await daemons.target(type, fields) }
    )
}

private let fast = WorkspaceTransfer.Timing(pollInterval: .milliseconds(1), pollTimeout: .seconds(2))

@Suite struct WorkspaceTransferTests {
    @Test func movesAWorkspaceAndHandsOverTheChat() async throws {
        let daemons = TwoDaemons()
        let (source, target) = endpoints(daemons)
        let name = try await WorkspaceTransfer.run(workspace: "parser", from: source, to: target, timing: fast)
        #expect(name == "parser")
        let order = await daemons.order
        #expect(order.contains("dst:import_workspace_from_remote"))
        #expect(order.contains("dst:queue_chat_input"))
        // Publish before create, hand over before retire.
        #expect(order.firstIndex(of: "src:push_branch")! < order.firstIndex(of: "dst:import_workspace_from_remote")!)
        #expect(order.firstIndex(of: "dst:queue_chat_input")! < order.firstIndex(of: "src:archive_workspace")!)
        #expect(await daemons.archivedSource)
    }

    @Test func refusesALiveSessionAndPushesNothing() async throws {
        let daemons = TwoDaemons()
        await daemons.configure { $0.liveSession = true }
        let (source, target) = endpoints(daemons)
        await #expect(throws: WorkspaceTransfer.Failure.self) {
            try await WorkspaceTransfer.run(workspace: "parser", from: source, to: target, timing: fast)
        }
        let order = await daemons.order
        #expect(!order.contains("src:push_branch"))
        #expect(!order.contains("src:kill_session"))
    }

    @Test func forceStopsTheSessionBeforePushing() async throws {
        let daemons = TwoDaemons()
        await daemons.configure { $0.liveSession = true }
        let (source, target) = endpoints(daemons)
        try await WorkspaceTransfer.run(workspace: "parser", from: source, to: target, force: true, timing: fast)
        let order = await daemons.order
        #expect(order.firstIndex(of: "src:kill_session")! < order.firstIndex(of: "src:push_branch")!)
    }

    @Test func takesAWorkspaceBackByRestoringItsArchivedOriginal() async throws {
        let daemons = TwoDaemons()
        await daemons.configure {
            $0.targetWorkspace = ("archived", $0.pushed)
            $0.staleChat = true
        }
        let (source, target) = endpoints(daemons)
        try await WorkspaceTransfer.run(workspace: "parser", from: source, to: target, timing: fast)
        let order = await daemons.order
        #expect(order.contains("dst:restore_workspace"))
        #expect(!order.contains("dst:import_workspace_from_remote"))
        // The restored copy's own chat is stale: the current conversation is
        // seeded fresh, and that chat is the one handed the turn.
        #expect(order.contains("dst:close_chat_thread"))
        #expect(await daemons.seededTranscript == 1)
        #expect(await daemons.queuedThread == 12)
        #expect(await daemons.archivedSource)
    }

    @Test func refusesWhenTheRestoredCopyHasMovedOn() async throws {
        let daemons = TwoDaemons()
        await daemons.configure { $0.targetWorkspace = ("archived", "0000000aaa") }
        let (source, target) = endpoints(daemons)
        await #expect(throws: WorkspaceTransfer.Failure.self) {
            try await WorkspaceTransfer.run(workspace: "parser", from: source, to: target, timing: fast)
        }
        #expect(await !daemons.archivedSource)
    }

    @Test func seedsTheCurrentConversationWhenAReturnTripWasInterruptedAfterItsRestore() async throws {
        // Restored on an earlier attempt that then failed: active now, so this
        // pass restores nothing, but its chat is still the stale one.
        let daemons = TwoDaemons()
        await daemons.configure {
            $0.targetWorkspace = ("active", $0.pushed)
            $0.staleChat = true
            $0.delivered = true
        }
        let (source, target) = endpoints(daemons)
        try await WorkspaceTransfer.run(workspace: "parser", from: source, to: target, timing: fast)
        let order = await daemons.order
        #expect(!order.contains("dst:restore_workspace"))
        #expect(await daemons.seededTranscript == 1)
        #expect(!order.contains("dst:close_chat_thread"))
    }

    @Test func doesNotHandTheChatOverTwice() async throws {
        let daemons = TwoDaemons()
        await daemons.configure {
            $0.targetWorkspace = ("active", $0.pushed)
            $0.delivered = true
        }
        let (source, target) = endpoints(daemons)
        try await WorkspaceTransfer.run(workspace: "parser", from: source, to: target, timing: fast)
        #expect(await !daemons.order.contains("dst:queue_chat_input"))
    }

    @Test func refusesTheSameDaemonReachedTwoWays() async throws {
        let daemons = TwoDaemons()
        await daemons.configure { $0.sameIdentity = true }
        let (source, target) = endpoints(daemons)
        await #expect(throws: WorkspaceTransfer.Failure.self) {
            try await WorkspaceTransfer.run(workspace: "parser", from: source, to: target, timing: fast)
        }
        #expect(await !daemons.order.contains("src:push_branch"))
    }

    @Test func helpersMatchTheDesktop() {
        #expect(WorkspaceTransfer.repositoryURLTail("git@github.com:Me/App.git") == "me/app")
        #expect(WorkspaceTransfer.repositoryURLTail("https://github.com/me/app/") == "me/app")
        #expect(WorkspaceTransfer.repositoryURLTail("ssh://git@host:22/me/app.git") == "me/app")
        #expect(WorkspaceTransfer.commitsMatch("abc1234", "abc1234def"))
        #expect(!WorkspaceTransfer.commitsMatch("abc12", "abc12"))
        #expect(!WorkspaceTransfer.commitsMatch("abc1234", "abc1235"))
        let pending = WorkspaceTransfer.resumeMessage(
            transcript: [.object(["role": "user", "content": " do it "])], fromLabel: "A", toLabel: "B",
            commit: "abc1234def5678")
        #expect(pending.hasPrefix("This conversation moved from daemon A to B; the branch is at abc1234def56."))
        #expect(pending.hasSuffix("\n\ndo it"))
    }
}

@Suite struct TailscaleDiscoveryTests {
    private func peer(_ host: String, _ ip: String, listener: Bool = true) -> TailscalePeer {
        let json = """
            {"host_name":"\(host)","dns_name":"\(host.lowercased()).tail1.ts.net","ip":"\(ip)","os":"linux",
             "archcar_listener":\(listener),"listener_port":7420,"tailscale_ssh":true,"transport":"ssh",
             "suggested_address":"ssh://x","needs_token":false,"saved":false}
            """
        return try! JSONDecoder().decode(TailscalePeer.self, from: Data(json.utf8))
    }

    @Test func keepsReachableUnsavedPeers() {
        let saved = [SavedDaemon(label: "box", address: DaemonAddress(host: "100.64.0.2", port: 7420))]
        let kept = TailscaleDiscovery.filter(
            [peer("Box", "100.64.0.2"), peer("Mac", "100.64.0.3"), peer("SshOnly", "100.64.0.4", listener: false)],
            excluding: saved)
        #expect(kept.map(\.hostName) == ["Mac"])
        #expect(kept[0].address == DaemonAddress(host: "mac.tail1.ts.net", port: 7420))
    }

    @Test func matchesASavedMagicDNSName() {
        let saved = [SavedDaemon(label: "m", address: DaemonAddress(host: "MAC.tail1.ts.net.", port: 7420))]
        #expect(TailscaleDiscovery.filter([peer("Mac", "100.64.0.3")], excluding: saved).isEmpty)
    }
}
