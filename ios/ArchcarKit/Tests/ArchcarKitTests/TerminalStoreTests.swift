import Foundation
import Testing

@testable import ArchcarKit

private let report = """
Setups
No setup runs recorded.

Runs
No runs recorded.

Checks
No check runs recorded.

Sessions
#2 /bin/zsh running pid=32518 exit=- started=1789983916 log=/tmp/x.log
#1 /bin/zsh exited pid=29454 exit=0 started=1789983828 log=/tmp/y.log
"""

@Test func findsTheNewestRunningShell() {
    // The daemon has no structured session listing, so this text is the
    // interface; an exited session must not be attached to.
    #expect(TerminalStore.newestRunningShell(in: report) == 2)
}

@Test func ignoresAgentSessions() {
    // Agents are listed in the same block. Attaching to one would send raw
    // keystrokes into a running Codex or Claude session.
    let mixed = """
    Sessions
    #9 /Users/me/.local/bin/claude running pid=5 exit=- started=3 log=/tmp/c.log
    #8 /usr/local/bin/codex running pid=4 exit=- started=2 log=/tmp/x.log
    #3 /bin/zsh running pid=3 exit=- started=1 log=/tmp/z.log
    """
    #expect(TerminalStore.newestRunningShell(in: mixed) == 3)

    let agentsOnly = """
    Sessions
    #9 /usr/local/bin/codex running pid=4 exit=- started=2 log=/tmp/x.log
    """
    #expect(TerminalStore.newestRunningShell(in: agentsOnly) == nil)
}

@Test func returnsNothingWhenNoSessionRuns() {
    let quiet = """
    Sessions
    #1 /bin/zsh exited pid=1 exit=0 started=1 log=/tmp/a.log
    """
    #expect(TerminalStore.newestRunningShell(in: quiet) == nil)
    #expect(TerminalStore.newestRunningShell(in: "Sessions\nNo sessions recorded.") == nil)
    #expect(TerminalStore.newestRunningShell(in: "") == nil)
}

@Test func ignoresSessionsBeforeTheSessionsHeading() {
    // "#3" in an earlier section is not a session id.
    let noisy = """
    Runs
    #3 make build running pid=1

    Sessions
    #7 /bin/zsh running pid=2 exit=- started=1
    """
    #expect(TerminalStore.newestRunningShell(in: noisy) == 7)
}

@MainActor
@Test func trimsThePaddedScreen() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond { line in
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let id = object["id"] as? String,
              let payload = object["payload"] as? [String: Any],
              payload["type"] as? String == "get_session_screen" else { return nil }
        // What a real shell returns: one line of output, then the rest of the
        // 24-row grid as blanks.
        let padding = String(repeating: "\\n", count: 20)
        return #"{"id":"\#(id)","payload":{"type":"session_screen","session_id":1,"screen":"$ echo hi   \#(padding)"}}"#
    }
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let terminal = TerminalStore(session: session, workspace: "w")
    await terminal.attachForTesting(sessionID: 1)
    await terminal.refreshScreen()

    #expect(terminal.screen.hasSuffix("\n"))
    #expect(terminal.displayScreen == "$ echo hi")

    await session.disconnect()
    await daemon.stop()
}

/// Answers the processes report with `processes` and a screen naming the
/// session it was asked for, so a test can tell which shell is attached.
private func terminalResponder(processes: String) -> @Sendable (String) -> String? {
    { line in
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let id = object["id"] as? String,
              let payload = object["payload"] as? [String: Any],
              let type = payload["type"] as? String else { return nil }
        switch type {
        case "get_workspace_processes":
            return #"{"id":"\#(id)","payload":{"type":"workspace_processes","workspace":"w","text":"\#(processes)"}}"#
        case "get_session_screen":
            let sessionID = (payload["session_id"] as? NSNumber)?.int64Value ?? 0
            return #"{"id":"\#(id)","payload":{"type":"session_screen","session_id":\#(sessionID),"screen":"shell \#(sessionID)"}}"#
        case "send_input":
            return #"{"id":"\#(id)","payload":{"type":"ack"}}"#
        default:
            return nil
        }
    }
}

/// Attaches a store to shell #2, drops the event stream, and reconnects.
/// Returns the store and a cleanup to run at the end of the test.
@MainActor
private func reconnectAttachedTerminal(processes: String) async throws -> (TerminalStore, () async -> Void) {
    let daemon = try await MockDaemon()
    await daemon.respond(to: terminalResponder(processes: processes))
    let session = DaemonSession(
        address: await daemon.address, token: "t",
        backoff: Backoff(base: .seconds(30), cap: .seconds(30)))
    try await session.connect()
    let store = TerminalStore(session: session, workspace: "w")
    store.attachForTesting(sessionID: 2)
    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))

    await daemon.endEventConnection()
    #expect(await eventually { await session.connectionState != .connected })
    await session.reconnectNow()
    // Every outcome starts with the processes report.
    #expect(await eventually {
        await daemon.receivedLines.contains { $0.contains("get_workspace_processes") }
    })
    return (store, {
        observing.cancel()
        await session.disconnect()
        await daemon.stop()
    })
}

@MainActor
@Test func reattachesWhenTheShellWasReplacedDuringAnOutage() async throws {
    // Shell #2 exited while the link was down and #5 replaced it.
    let (store, finish) = try await reconnectAttachedTerminal(
        processes: "Sessions\\n#5 /bin/zsh running pid=9 exit=- started=2 log=/tmp/b.log\\n#2 /bin/zsh exited pid=8 exit=0 started=1 log=/tmp/a.log")

    // Keystrokes must go to the shell that is running, not the one that left.
    #expect(await eventually { @MainActor in store.sessionID == 5 })
    #expect(await eventually { @MainActor in store.screen == "shell 5" })
    await finish()
}

@MainActor
@Test func keepsTheShellWhenTheListingFails() async throws {
    // What the daemon reports when its own session query fails. No shells
    // are listed, but that is no evidence #2 is gone.
    let (store, finish) = try await reconnectAttachedTerminal(
        processes: "Sessions\\nCould not read: database is locked")

    #expect(await eventually { @MainActor in store.screen == "shell 2" })
    #expect(store.sessionID == 2)
    await finish()
}

@MainActor
@Test func detachesWhenTheShellExitedAndNoneReplacedIt() async throws {
    let (store, finish) = try await reconnectAttachedTerminal(
        processes: "Sessions\\n#2 /bin/zsh exited pid=8 exit=0 started=1 log=/tmp/a.log")

    #expect(await eventually { @MainActor in store.sessionID == nil })
    #expect(store.isStale == false)
    await finish()
}

@MainActor
@Test func clearsTheStaleMarkWhenNoShellWasAttachedAtTheDrop() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: terminalResponder(processes: "Sessions"))
    let session = DaemonSession(
        address: await daemon.address, token: "t",
        backoff: Backoff(base: .seconds(30), cap: .seconds(30)))
    try await session.connect()
    // Nothing attached: the panel is open, but no shell is running.
    let store = TerminalStore(session: session, workspace: "w")
    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))

    await daemon.endEventConnection()
    #expect(await eventually { @MainActor in store.isStale })
    await session.reconnectNow()

    // The daemon answering is what proves the link is back; there being no
    // shell to show must not keep the mark up.
    #expect(await eventually { @MainActor in !store.isStale })
    #expect(store.sessionID == nil)

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func aDroppedStreamMarksTerminalStaleAndRefetchesOnReconnect() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: terminalResponder(
        processes: "Sessions\\n#2 /bin/zsh running pid=8 exit=- started=1 log=/tmp/a.log"))
    // Too slow to reconnect on its own within the test, so the stale state
    // holds until `reconnectNow` ends it.
    let session = DaemonSession(
        address: await daemon.address, token: "t",
        backoff: Backoff(base: .seconds(30), cap: .seconds(30)))
    try await session.connect()
    let store = TerminalStore(session: session, workspace: "w")
    store.attachForTesting(sessionID: 2)
    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))
    #expect(store.isStale == false)
    let before = await daemon.receivedLines.count

    await daemon.endEventConnection()

    // Stale straight away, and not because a request failed: none was sent.
    #expect(await eventually { @MainActor in store.isStale })
    #expect(await daemon.receivedLines.count == before)

    await session.reconnectNow()

    // The reattach check and screen refetch clear the mark.
    #expect(await eventually {
        await daemon.receivedLines.dropFirst(before).contains { $0.contains("get_workspace_processes") }
    })
    #expect(await eventually { @MainActor in store.screen == "shell 2" })
    #expect(await eventually { @MainActor in !store.isStale })

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func typingWhileTheStreamIsUpKeepsTheTerminalCurrent() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: terminalResponder(processes: "Sessions"))
    let session = DaemonSession(address: await daemon.address, token: "t")
    try await session.connect()
    let store = TerminalStore(session: session, workspace: "w")
    store.attachForTesting(sessionID: 2)
    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))

    await store.send("ls")
    await store.sendControl("c")

    // The stream is up and the screen was just refetched: nothing is stale.
    #expect(await session.connectionState == .connected)
    #expect(store.screen == "shell 2")
    #expect(store.isStale == false)

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}

@MainActor
@Test func aScreenFetchWhileTheStreamIsDownKeepsTheTerminalStale() async throws {
    let daemon = try await MockDaemon()
    await daemon.respond(to: terminalResponder(processes: "Sessions"))
    // Too slow to reconnect on its own within the test, so the stream stays
    // down for as long as the test needs it to.
    let session = DaemonSession(
        address: await daemon.address, token: "t",
        backoff: Backoff(base: .seconds(30), cap: .seconds(30)))
    try await session.connect()
    let store = TerminalStore(session: session, workspace: "w")
    store.attachForTesting(sessionID: 2)
    let observing = Task { await store.observe() }
    try await Task.sleep(for: .milliseconds(150))

    await daemon.endEventConnection()
    #expect(await eventually { @MainActor in store.isStale })

    // Typing and the screen fetch each open their own connection, so they
    // succeed even though the event stream is still down.
    await store.send("ls")
    await store.refreshScreen()
    #expect(store.screen == "shell 2")
    #expect(store.lastError == nil)
    #expect(await session.connectionState != .connected)

    // Screen updates are not arriving, so the terminal must still say so.
    #expect(store.isStale)

    observing.cancel()
    await session.disconnect()
    await daemon.stop()
}
