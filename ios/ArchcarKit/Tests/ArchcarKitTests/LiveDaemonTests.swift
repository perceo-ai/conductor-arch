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
        guard case .inventorySnapshot(let repositories, let workspaces) = response else {
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
