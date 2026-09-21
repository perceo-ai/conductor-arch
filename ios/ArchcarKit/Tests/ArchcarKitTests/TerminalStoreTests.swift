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
    #expect(TerminalStore.newestRunningSession(in: report) == 2)
}

@Test func returnsNothingWhenNoSessionRuns() {
    let quiet = """
    Sessions
    #1 /bin/zsh exited pid=1 exit=0 started=1 log=/tmp/a.log
    """
    #expect(TerminalStore.newestRunningSession(in: quiet) == nil)
    #expect(TerminalStore.newestRunningSession(in: "Sessions\nNo sessions recorded.") == nil)
    #expect(TerminalStore.newestRunningSession(in: "") == nil)
}

@Test func ignoresSessionsBeforeTheSessionsHeading() {
    // "#3" in an earlier section is not a session id.
    let noisy = """
    Runs
    #3 make build running pid=1

    Sessions
    #7 /bin/zsh running pid=2 exit=- started=1
    """
    #expect(TerminalStore.newestRunningSession(in: noisy) == 7)
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
