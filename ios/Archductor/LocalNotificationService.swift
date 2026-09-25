import ArchcarKit
import Foundation
import UIKit
@preconcurrency import UserNotifications

@MainActor
final class LocalNotificationService: NSObject, UNUserNotificationCenterDelegate {
    private let center: UNUserNotificationCenter
    private var authorizationRequested = false

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
        [.banner, .sound]
    }
}
