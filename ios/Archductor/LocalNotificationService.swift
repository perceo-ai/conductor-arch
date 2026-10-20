import ArchcarKit
import Foundation
import UIKit
@preconcurrency import UserNotifications

@MainActor
final class LocalNotificationService: NSObject, UNUserNotificationCenterDelegate {
    private let center: UNUserNotificationCenter
    private var authorizationRequested = false
    /// Answers "is a daemon socket delivering events right now" — set by the
    /// app model, read when a remote push arrives in the foreground so the
    /// duplicate of an already-scheduled local notification is not shown.
    var hasLiveDaemonSession: @MainActor () -> Bool = { false }
    /// Called with the chat (and, for a local notification, the daemon that
    /// sent it) when the user taps a notification — set by the app model,
    /// which opens that chat.
    var onNotificationTapped: @MainActor (NotificationTap) -> Void = { _ in }

    /// This object is the notification center's only delegate, so taps on
    /// local notifications *and* APNs pushes both arrive at `didReceive` below.
    /// Apple requires the delegate to be set before launch finishes for a tap
    /// that cold-launches the app to be delivered; `AppModel` (and so this) is
    /// built in `ArchductorApp`'s initializer, which runs before that.
    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
        super.init()
        center.delegate = self
    }

    /// - Parameter daemonID: the daemon the event came from, stamped next to
    ///   `thread_id` so a tap is never resolved against a different daemon
    ///   whose thread ids overlap.
    func deliver(_ descriptor: EventNotificationDescriptor, daemonID: String?) async {
        guard await ensureAuthorized() else { return }

        let content = UNMutableNotificationContent()
        content.title = descriptor.title
        content.body = descriptor.body
        content.sound = .default
        if let threadID = descriptor.threadID {
            var userInfo: [AnyHashable: Any] = ["thread_id": threadID]
            if let daemonID { userInfo["daemon_id"] = daemonID }
            content.userInfo = userInfo
        }

        let request = UNNotificationRequest(
            identifier: descriptor.id,
            content: content,
            trigger: nil)
        try? await center.add(request)
    }

    /// Clears every delivered and scheduled notification. Run when switching
    /// daemons: what is in the tray belongs to the daemon being left, and its
    /// thread ids mean other chats on the next one.
    func removeAll() {
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
    }

    private func ensureAuthorized() async -> Bool {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .denied:
            return false
        case .notDetermined:
            guard !authorizationRequested else { return false }
            authorizationRequested = true
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
            }
            return granted
        @unknown default:
            return false
        }
    }

    /// Connect-time setup: ask for permission if it has never been asked, and
    /// register for remote pushes when allowed. Waiting for the first event to
    /// prompt meant a fresh install that was backgrounded before any event had
    /// no APNs token registered — and could then never be reached at all.
    func requestAuthorizationAndRegister() async {
        _ = await ensureAuthorized()
        await registerForRemoteNotificationsIfAllowed()
    }

    func registerForRemoteNotificationsIfAllowed() async {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        case .denied, .notDetermined:
            break
        @unknown default:
            break
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let isRemotePush = notification.request.trigger is UNPushNotificationTrigger
        let connected = await MainActor.run { hasLiveDaemonSession() }
        return NotificationPresentationPolicy.shouldPresent(
            isRemotePush: isRemotePush, hasLiveDaemonSession: connected)
            ? [.banner, .sound] : []
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        // Only a plain tap opens the chat; dismissing the notification is not
        // a request to look at it.
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        guard let tap = ChatThreadLookup.tap(
            fromUserInfo: response.notification.request.content.userInfo)
        else { return }
        await MainActor.run { onNotificationTapped(tap) }
    }
}
