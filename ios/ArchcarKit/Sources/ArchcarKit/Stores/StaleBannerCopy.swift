import Foundation

/// The stale banner's wording. A store marks itself stale both when the event
/// stream drops and when one request fails on a live connection, so the
/// banner only claims "not connected" for the first; for the second it shows
/// the error the store kept.
public enum StaleBannerCopy {
    public static let disconnected = "Showing last known state — not connected"

    public static func text(isDisconnected: Bool, cause: String?) -> String {
        guard !isDisconnected else { return disconnected }
        if let cause, !cause.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Could not refresh — \(cause)"
        }
        return "Could not refresh the latest data"
    }
}
