import UIKit

/// Only forwards the APNs device token. Tapping a push is *not* handled here:
/// `LocalNotificationService` is the `UNUserNotificationCenter` delegate, and
/// iOS routes taps on remote and local notifications alike through its
/// `userNotificationCenter(_:didReceive:)`, including a tap that launches the
/// app. `AppModel.handleNotificationTap` takes it from there.
@MainActor
final class RemoteNotificationDelegate: NSObject, UIApplicationDelegate {
    static var onDeviceToken: ((String) -> Void)?

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Self.onDeviceToken?(deviceToken.map { String(format: "%02x", $0) }.joined())
    }
}
