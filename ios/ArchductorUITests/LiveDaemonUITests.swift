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
