import Foundation

/// Formats archcar timestamps.
///
/// They are typed `String` on the wire but hold epoch *seconds*, so parsing
/// them as a date string yields nothing. Everything user-facing goes through
/// here rather than through a date parser.
public enum RelativeTime {
    public static func format(epochSecondsString: String, now: Date = Date()) -> String {
        guard let seconds = Double(epochSecondsString.trimmingCharacters(in: .whitespaces)) else {
            return "—"
        }
        let elapsed = max(0, now.timeIntervalSince1970 - seconds)
        switch elapsed {
        case ..<60: return "\(Int(elapsed))s ago"
        case ..<3600: return "\(Int(elapsed / 60))m ago"
        case ..<86400: return "\(Int(elapsed / 3600))h ago"
        default: return "\(Int(elapsed / 86400))d ago"
        }
    }
}
