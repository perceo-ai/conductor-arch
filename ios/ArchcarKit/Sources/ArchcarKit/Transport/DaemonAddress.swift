import Foundation

/// Where a daemon listens. `host` alone means the default remote port.
public struct DaemonAddress: Codable, Sendable, Hashable, CustomStringConvertible {
    /// Matches `remote::DEFAULT_REMOTE_PORT`.
    public static let defaultPort: UInt16 = 7420

    public let host: String
    public let port: UInt16

    public init(host: String, port: UInt16 = DaemonAddress.defaultPort) {
        self.host = host
        self.port = port
    }

    /// Parses `host`, `host:port`, or `[v6]:port`. Returns nil for anything
    /// else, so a typo in the pairing screen is a validation message rather
    /// than a connection that hangs.
    public init?(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("[") {
            guard let close = trimmed.firstIndex(of: "]") else { return nil }
            let host = String(trimmed[trimmed.index(after: trimmed.startIndex)..<close])
            let rest = trimmed[trimmed.index(after: close)...]
            guard !host.isEmpty else { return nil }
            if rest.isEmpty {
                self.init(host: host)
                return
            }
            guard rest.hasPrefix(":"), let port = UInt16(rest.dropFirst()) else { return nil }
            self.init(host: host, port: port)
            return
        }
        let parts = trimmed.split(separator: ":", omittingEmptySubsequences: false)
        switch parts.count {
        case 1:
            self.init(host: String(parts[0]))
        case 2:
            guard let port = UInt16(parts[1]), !parts[0].isEmpty else { return nil }
            self.init(host: String(parts[0]), port: port)
        default:
            return nil
        }
    }

    public var description: String {
        host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)"
    }

    /// The pairing screen requires an explicit acknowledgement for anything
    /// that is not this, because the token then crosses a real network.
    public var isLoopback: Bool {
        host == "localhost" || host == "127.0.0.1" || host == "::1"
    }
}
