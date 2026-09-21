import XCTest

/// Drives the real app against a real daemon: pair by hand, then read the
/// workspace list off the socket. Skipped unless the harness supplies an
/// address and token, so the default test run stays hermetic.
///
/// Run it with:
///   ARCHDUCTOR_UITEST_ADDRESS=127.0.0.1:17420 \
///   ARCHDUCTOR_UITEST_TOKEN=smoke-token \
///   ARCHDUCTOR_UITEST_WORKSPACE=phone-check \
///   xcodebuild … test
final class LiveDaemonUITests: XCTestCase {
    private struct LiveConfig {
        let address: String
        let token: String
        let workspace: String
    }

    private func liveConfig() throws -> LiveConfig {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARCHDUCTOR_UITEST_ADDRESS"],
              let token = environment["ARCHDUCTOR_UITEST_TOKEN"],
              let workspace = environment["ARCHDUCTOR_UITEST_WORKSPACE"] else {
            throw XCTSkip("No live daemon configured for this run.")
        }
        return LiveConfig(address: address, token: token, workspace: workspace)
    }

    /// Pairs the app with the daemon and leaves it on the Workspaces tab.
    @discardableResult
    private func pair(_ app: XCUIApplication, with config: LiveConfig) -> XCUIApplication {
        app.launchArguments = ["--uitest-reset"]
        app.launch()

        app.tabBars.buttons["More"].tap()
        app.buttons["Pair a daemon…"].tap()

        let addressField = app.textFields["Address (host or host:port)"]
        XCTAssertTrue(addressField.waitForExistence(timeout: 10))
        addressField.tap()
        addressField.typeText(config.address)

        let tokenField = app.secureTextFields["Token"]
        tokenField.tap()
        tokenField.typeText(config.token)
        app.buttons["dismiss-keyboard"].tap()

        let acknowledgement = app.switches["cleartext-acknowledgement"]
        if acknowledgement.waitForExistence(timeout: 2) {
            acknowledgement.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        }
        app.buttons["Save"].tap()

        let workspacesTab = app.tabBars.buttons["Workspaces"]
        XCTAssertTrue(workspacesTab.waitForExistence(timeout: 10))
        for _ in 0..<5 where !workspacesTab.isSelected {
            workspacesTab.tap()
            _ = workspacesTab.waitForExistence(timeout: 1)
        }
        return app
    }

    /// Drills into a workspace, creates a chat, and opens it — the P1 path that
    /// only means anything against a daemon that can actually make a thread.
    func testCreatesAndOpensAChatOnALiveDaemon() throws {
        let config = try liveConfig()
        let app = pair(XCUIApplication(), with: config)

        XCTAssertTrue(app.staticTexts[config.workspace].waitForExistence(timeout: 20))
        // The row is a navigation link whose accessibility children are
        // combined, so the label text itself is not the tappable element.
        let workspaceRow = app.buttons
            .containing(NSPredicate(format: "label CONTAINS %@", config.workspace))
            .firstMatch
        XCTAssertTrue(workspaceRow.waitForExistence(timeout: 5))
        workspaceRow.tap()

        XCTAssertTrue(app.buttons["New chat"].waitForExistence(timeout: 10))
        app.buttons["New chat"].tap()

        let titleField = app.textFields["Title"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))
        titleField.tap()
        titleField.typeText("Phone chat")
        app.buttons["Create"].tap()

        // The thread must come back from the daemon and land in the list.
        XCTAssertTrue(
            app.staticTexts["Phone chat"].waitForExistence(timeout: 15),
            "created chat never appeared")
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Phone chat"))
            .firstMatch.tap()

        // An empty conversation still has a composer: that is the difference
        // between a chat you can drive and a transcript you can only read.
        XCTAssertTrue(app.textFields["chat-composer"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["No messages yet"].exists)

        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "chat-live"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Renders a transcript that already exists on the daemon.
    ///
    /// Seeded provider events stand in for an agent run, which keeps the test
    /// deterministic and free of provider auth while still exercising the real
    /// projection: bubbles for chat, a card for everything else.
    func testRendersAnExistingTranscript() throws {
        let config = try liveConfig()
        let environment = ProcessInfo.processInfo.environment
        guard let chatTitle = environment["ARCHDUCTOR_UITEST_CHAT"],
              let userLine = environment["ARCHDUCTOR_UITEST_USER_LINE"],
              let cardTitle = environment["ARCHDUCTOR_UITEST_CARD_TITLE"] else {
            throw XCTSkip("No seeded transcript configured for this run.")
        }
        let app = pair(XCUIApplication(), with: config)

        XCTAssertTrue(app.staticTexts[config.workspace].waitForExistence(timeout: 20))
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", config.workspace))
            .firstMatch.tap()

        XCTAssertTrue(app.staticTexts[chatTitle].waitForExistence(timeout: 15))
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", chatTitle))
            .firstMatch.tap()

        // The user turn and the agent's reply are bubbles; a command is a
        // collapsed card, so its body stays hidden until it is opened.
        XCTAssertTrue(app.staticTexts[userLine].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts[cardTitle].exists)

        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "transcript-live"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// The whole point of the app, against a real agent: type a turn on the
    /// phone, and watch the provider's answer arrive in the transcript.
    ///
    /// Needs an authenticated provider on the daemon's machine, so it is opt-in
    /// via ARCHDUCTOR_UITEST_AGENT_CHAT.
    func testSendsATurnToARealAgent() throws {
        let config = try liveConfig()
        let environment = ProcessInfo.processInfo.environment
        guard let chatTitle = environment["ARCHDUCTOR_UITEST_AGENT_CHAT"],
              let prompt = environment["ARCHDUCTOR_UITEST_PROMPT"],
              let expected = environment["ARCHDUCTOR_UITEST_EXPECTED"] else {
            throw XCTSkip("No authenticated agent configured for this run.")
        }
        let app = pair(XCUIApplication(), with: config)

        XCTAssertTrue(app.staticTexts[config.workspace].waitForExistence(timeout: 20))
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", config.workspace))
            .firstMatch.tap()

        XCTAssertTrue(app.staticTexts[chatTitle].waitForExistence(timeout: 15))
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", chatTitle))
            .firstMatch.tap()

        let composer = app.textFields["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText(prompt)
        app.buttons["chat-send"].tap()

        // The turn has to reach the daemon, start a provider session, run, and
        // come back through the event stream into the projection. A real model
        // is slow, hence the generous window.
        // Exact match, not CONTAINS: the prompt bubble contains the word too,
        // so a loose predicate passes the moment the turn is sent and proves
        // nothing about the agent answering.
        let answer = app.staticTexts[expected]
        XCTAssertTrue(
            answer.waitForExistence(timeout: 180),
            "the agent's answer never reached the transcript")

        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "agent-turn-live"
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testPairsWithALiveDaemonAndListsItsWorkspaces() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARCHDUCTOR_UITEST_ADDRESS"],
              let token = environment["ARCHDUCTOR_UITEST_TOKEN"],
              let workspace = environment["ARCHDUCTOR_UITEST_WORKSPACE"] else {
            throw XCTSkip("No live daemon configured for this run.")
        }

        let app = XCUIApplication()
        app.launchArguments = ["--uitest-reset"]
        app.launch()

        app.tabBars.buttons["More"].tap()
        app.buttons["Pair a daemon…"].tap()

        let addressField = app.textFields["Address (host or host:port)"]
        XCTAssertTrue(addressField.waitForExistence(timeout: 10))
        addressField.tap()
        addressField.typeText(address)

        let tokenField = app.secureTextFields["Token"]
        tokenField.tap()
        tokenField.typeText(token)
        app.buttons["dismiss-keyboard"].tap()

        let acknowledgement = app.switches["cleartext-acknowledgement"]
        if acknowledgement.waitForExistence(timeout: 2) {
            acknowledgement.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        }

        app.buttons["Save"].tap()

        // The daemon token must not be offered to iCloud Keychain: the app
        // stores it as device-only on purpose, and a synced copy would undo
        // that for every device on the account.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let savePasswordPrompt = springboard.alerts.staticTexts["Save Password?"]
        XCTAssertFalse(
            savePasswordPrompt.waitForExistence(timeout: 5),
            "iOS offered to save the daemon token as a password")

        // Back on the workspaces tab, the seeded workspace must appear — which
        // means the token was accepted, the inventory decoded, and the row
        // rendered from real daemon state.
        //
        // The tab tap needs confirming: right after the sheet dismisses the tab
        // bar can swallow a tap mid-animation, which reads as a pairing failure
        // when nothing is actually wrong.
        let workspacesTab = app.tabBars.buttons["Workspaces"]
        XCTAssertTrue(workspacesTab.waitForExistence(timeout: 10))
        for _ in 0..<5 where !workspacesTab.isSelected {
            workspacesTab.tap()
            _ = workspacesTab.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(workspacesTab.isSelected, "could not switch to the Workspaces tab")
        let row = app.staticTexts[workspace]
        if !row.waitForExistence(timeout: 20) {
            let failure = XCTAttachment(screenshot: app.screenshot())
            failure.name = "pairing-failure"
            failure.lifetime = .keepAlways
            add(failure)
            XCTFail("workspace \(workspace) never appeared")
            return
        }

        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "workspaces-live"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
