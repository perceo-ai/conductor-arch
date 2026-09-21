import XCTest

final class LaunchTests: XCTestCase {
    /// XCUITest reads a snapshot of the hierarchy, so a SwiftUI state change
    /// made by a tap is not necessarily visible on the very next query.
    private func waitUntilEnabled(_ element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
        let predicate = NSPredicate(format: "isEnabled == true")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-reset"]
        app.launch()
        return app
    }

    func testLaunchesToWorkspacesTabWithNoDaemonPaired() {
        let app = launchApp()

        XCTAssertTrue(app.tabBars.buttons["Workspaces"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.tabBars.buttons["Chats"].exists)
        XCTAssertTrue(app.tabBars.buttons["Review"].exists)
        XCTAssertTrue(app.tabBars.buttons["More"].exists)
        // A fresh install has nothing paired, and that empty state is the first
        // screen a new user sees.
        XCTAssertTrue(app.staticTexts["No daemon paired"].waitForExistence(timeout: 10))
    }

    func testPairingSheetRequiresAcknowledgementForARemoteAddress() {
        let app = launchApp()

        app.tabBars.buttons["More"].tap()
        app.buttons["Pair a daemon…"].tap()

        let address = app.textFields["Address (host or host:port)"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText("10.0.0.4:7420")

        let token = app.secureTextFields["Token"]
        token.tap()
        token.typeText("some-token")

        app.buttons["dismiss-keyboard"].tap()

        // Save stays disabled until the cleartext risk is acknowledged.
        XCTAssertFalse(app.buttons["Save"].isEnabled)
        let acknowledgement = app.switches["cleartext-acknowledgement"]
        XCTAssertTrue(acknowledgement.waitForExistence(timeout: 10))
        // A SwiftUI Toggle in a Form exposes the whole row as the Switch, so a
        // centre tap can land on the label instead of the control; aim at the
        // trailing edge where the switch actually is.
        if acknowledgement.isHittable {
            acknowledgement.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        } else {
            XCTFail("acknowledgement toggle is not hittable: frame=\(acknowledgement.frame)")
            return
        }
        XCTAssertTrue(
            waitUntilEnabled(app.buttons["Save"]),
            "Save stayed disabled after acknowledging (toggle=\(acknowledgement.value ?? "nil"))")
    }

    func testLoopbackAddressNeedsNoAcknowledgement() {
        let app = launchApp()

        app.tabBars.buttons["More"].tap()
        app.buttons["Pair a daemon…"].tap()

        let address = app.textFields["Address (host or host:port)"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText("127.0.0.1:7420")
        app.secureTextFields["Token"].tap()
        app.secureTextFields["Token"].typeText("t")
        app.buttons["dismiss-keyboard"].tap()

        // Loopback never leaves the device, so the warning would be noise.
        XCTAssertFalse(app.switches["cleartext-acknowledgement"].exists)
        XCTAssertTrue(waitUntilEnabled(app.buttons["Save"]))
    }
}
