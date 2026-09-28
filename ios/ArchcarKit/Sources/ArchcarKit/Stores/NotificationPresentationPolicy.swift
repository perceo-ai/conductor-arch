/// Whether a notification that arrived while the app is foregrounded should be
/// presented.
///
/// A phone with a live daemon session receives every event twice: once over
/// its socket subscription (which schedules a local notification) and once via
/// the daemon's APNs fan-out. Presenting both shows two banners for one event,
/// so the remote copy is suppressed while the socket is delivering. When the
/// app is backgrounded the socket is suspended, no local copy exists, and the
/// system presents the push without consulting this policy at all.
public enum NotificationPresentationPolicy {
    public static func shouldPresent(isRemotePush: Bool, hasLiveDaemonSession: Bool) -> Bool {
        !(isRemotePush && hasLiveDaemonSession)
    }
}
