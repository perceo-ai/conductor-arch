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

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
        super.init()
        center.delegate = self
    }

    func deliver(_ descriptor: EventNotificationDescriptor) async {
        guard await ensureAuthorized() else { return }

        let content = UNMutableNotificationContent()
        content.title = descriptor.title
        content.body = descriptor.body
        content.sound = .default
        if let threadID = descriptor.threadID {
            content.userInfo = ["thread_id": threadID]
        }

        let request = UNNotificationRequest(
            identifier: descriptor.id,
            content: content,
            trigger: nil)
        try? await center.add(request)
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
}
