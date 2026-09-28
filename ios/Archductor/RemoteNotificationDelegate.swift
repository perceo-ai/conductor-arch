import UIKit

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
