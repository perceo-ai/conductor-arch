import XCTest

/// Walks the app's screens against a live daemon and attaches a screenshot of
/// each one.
///
/// The look is the thing being checked, and nothing about a colour token is
/// visible in an assertion — so this exists to produce images a human (or the
/// next agent) can put next to the desktop. It only reads: it opens panels that
/// already exist and never creates, archives, or sends anything.
///
/// Skipped unless pointed at a daemon, the same contract as LiveDaemonUITests.
final class VisualTourUITests: XCTestCase {
    private var address = ""
    private var token = ""
    private var workspace = ""

    override func setUpWithError() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ARCHDUCTOR_UITEST_ADDRESS"],
            let token = environment["ARCHDUCTOR_UITEST_TOKEN"],
            let workspace = environment["ARCHDUCTOR_UITEST_WORKSPACE"]
        else {
            throw XCTSkip("No live daemon configured for this run.")
        }
        self.address = address
        self.token = token
        self.workspace = workspace
        continueAfterFailure = true
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testTourEveryScreen() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-reset"]
        app.launch()

        capture(app, "01-unpaired-workspaces")

        app.tabBars.buttons["More"].tap()
        capture(app, "02-more-unpaired")

        app.buttons["Pair a daemon…"].tap()
        let addressField = app.textFields["Address (host or host:port)"]
        XCTAssertTrue(addressField.waitForExistence(timeout: 10))
        capture(app, "03-pair")
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

        let workspacesTab = app.tabBars.buttons["Workspaces"]
        XCTAssertTrue(workspacesTab.waitForExistence(timeout: 10))
        for _ in 0..<5 where !workspacesTab.isSelected {
            workspacesTab.tap()
            _ = workspacesTab.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(app.staticTexts[workspace].waitForExistence(timeout: 20))
        capture(app, "04-workspaces")

        app.tabBars.buttons["Chats"].tap()
        _ = app.navigationBars["Chats"].waitForExistence(timeout: 5)
        capture(app, "05-chats")

        app.tabBars.buttons["More"].tap()
        capture(app, "06-more-paired")

        app.tabBars.buttons["Workspaces"].tap()
        let row = app.buttons
            .containing(NSPredicate(format: "label CONTAINS %@", workspace))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()

        for panel in ["Chat", "Changes", "Checks", "Todos", "Files"] {
            let button = app.buttons[panel]
            guard button.waitForExistence(timeout: 5) else { continue }
            button.tap()
            // The panels fetch; a screenshot of a spinner says nothing.
            Thread.sleep(forTimeInterval: 2.5)
            capture(app, "07-panel-\(panel.lowercased())")
        }

        // Back to Chat and into the first transcript, which is the screen the
        // app is mostly looked at through.
        app.buttons["Chat"].tap()
        let thread = app.scrollViews.buttons.firstMatch
        if thread.waitForExistence(timeout: 5) {
            thread.tap()
            Thread.sleep(forTimeInterval: 3)
            capture(app, "08-transcript")
        }
    }
}
