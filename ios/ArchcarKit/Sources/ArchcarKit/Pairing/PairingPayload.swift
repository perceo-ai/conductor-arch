import Foundation

public enum PairingError: Error, Equatable, Sendable {
    case malformed
    case unsupportedVersion(Int)
    case badAddress
}

/// What a pairing QR code carries.
///
/// This is a live credential in a picture: anyone who photographs the code can
/// drive that machine. The desktop renders it only on explicit reveal, and the
/// version field exists so a future transport (TLS with a pinned fingerprint)
/// can be told apart from this one rather than silently misread.
public struct PairingPayload: Codable, Sendable, Equatable {
    public static let currentVersion = 1

    public let version: Int
    public let label: String
    public let address: DaemonAddress
    public let token: String

    public init(
        version: Int = PairingPayload.currentVersion,
        label: String,
        address: DaemonAddress,
        token: String
    ) {
        self.version = version
        self.label = label
        self.address = address
        self.token = token
    }

    private enum CodingKeys: String, CodingKey {
        case version = "v"
        case label, address, token
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        label = try container.decode(String.self, forKey: .label)
        token = try container.decode(String.self, forKey: .token)
        let text = try container.decode(String.self, forKey: .address)
        guard let parsed = DaemonAddress(text) else { throw PairingError.badAddress }
        address = parsed
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(version, forKey: .version)
        try container.encode(label, forKey: .label)
        try container.encode(token, forKey: .token)
        try container.encode(address.description, forKey: .address)
    }

    public static func decode(_ scanned: String) throws -> PairingPayload {
        guard let data = scanned.data(using: .utf8) else { throw PairingError.malformed }
        let payload: PairingPayload
        do {
            payload = try JSONDecoder().decode(PairingPayload.self, from: data)
        } catch let error as PairingError {
            throw error
        } catch let DecodingError.dataCorrupted(context) where context.underlyingError is PairingError {
            throw context.underlyingError as! PairingError
        } catch {
            // A wrapped PairingError can arrive nested in a decoding failure
            // depending on where it was thrown; unwrap it rather than reporting
            // a bad address as unreadable JSON.
            if let pairing = Self.unwrapPairingError(error) { throw pairing }
            throw PairingError.malformed
        }
        guard payload.version == currentVersion else {
            throw PairingError.unsupportedVersion(payload.version)
        }
        return payload
    }

    private static func unwrapPairingError(_ error: Error) -> PairingError? {
        if let pairing = error as? PairingError { return pairing }
        guard let decoding = error as? DecodingError else { return nil }
        switch decoding {
        case .dataCorrupted(let context), .keyNotFound(_, let context),
             .typeMismatch(_, let context), .valueNotFound(_, let context):
            return context.underlyingError.flatMap { $0 as? PairingError }
        @unknown default:
            return nil
        }
    }

    public func encoded() throws -> String {
        String(decoding: try JSONEncoder().encode(self), as: UTF8.self)
    }
}
