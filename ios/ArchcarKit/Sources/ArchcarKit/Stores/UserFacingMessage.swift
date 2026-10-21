import Foundation

/// The text a screen shows when a request does not give it what it asked
/// for. Every user-visible field (`lastError`, `composerError`, `actionOutput`,
/// `connectionState`, the connect screen) is filled from here, so this is the
/// one place that owns that wording. It has no table of ArchcarKit's own
/// errors: `DaemonSessionError` and `ArchcarTransportError` carry their
/// sentences through `LocalizedError`, as do Foundation's Codable errors.
public enum UserFacingMessage {
    /// A request the caller's task cancelled. It was interrupted, not refused:
    /// the daemon may already have acted on it.
    public static let cancelled = "The request was interrupted before the daemon answered."

    /// A reply that decoded but is not one the request can use, such as a
    /// newer daemon's response type this build does not know.
    public static let unexpectedResponse = "The daemon sent an answer this app could not use."

    /// Foundation renders `CancellationError` as "The operation couldn't be
    /// completed. (Swift.CancellationError error 1.)", so it gets a sentence
    /// here; everything else already reads as one.
    public static func describing(_ error: any Error) -> String {
        switch error {
        case is CancellationError: cancelled
        default: error.localizedDescription
        }
    }

    /// What the pairing sheet shows when saving a scanned daemon throws,
    /// typically a Keychain refusal on a locked device.
    public static func pairingSaveFailureMessage(for error: any Error) -> String {
        "Could not save: \(describing(error))"
    }
}
