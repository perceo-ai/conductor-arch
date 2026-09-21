import Foundation

/// Exponential backoff for reconnect attempts.
///
/// Kept as a value type with an explicit `next()` so tests can assert the
/// schedule without sleeping through it.
public struct Backoff: Sendable {
    private let base: Duration
    private let cap: Duration
    private var attempt = 0

    public init(base: Duration = .milliseconds(500), cap: Duration = .seconds(30)) {
        self.base = base
        self.cap = cap
    }

    public mutating func next() -> Duration {
        let multiplier = 1 << min(attempt, 20)
        attempt += 1
        let scaled = base * multiplier
        return scaled > cap ? cap : scaled
    }

    public mutating func reset() { attempt = 0 }
}
