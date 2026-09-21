import Foundation
import Security

public protocol TokenStore: Sendable {
    func token(for id: String) throws -> String?
    func setToken(_ token: String, for id: String) throws
    func removeToken(for id: String) throws
}

/// Keychain-backed storage, device-only and unlock-gated.
///
/// `ThisDeviceOnly` keeps a daemon token out of an iCloud backup: a token that
/// syncs is a token that lands on a device the user never paired.
public struct KeychainTokenStore: TokenStore {
    private let service: String

    public init(service: String = "ai.perceo.archductor.daemon-token") {
        self.service = service
    }

    public func token(for id: String) throws -> String? {
        var query = baseQuery(id: id)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw KeychainError.status(status)
        }
        return String(decoding: data, as: UTF8.self)
    }

    public func setToken(_ token: String, for id: String) throws {
        try removeToken(for: id)
        var query = baseQuery(id: id)
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }

    public func removeToken(for id: String) throws {
        let status = SecItemDelete(baseQuery(id: id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.status(status)
        }
    }

    private func baseQuery(id: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id
        ]
    }

    public enum KeychainError: Error, Equatable {
        case status(OSStatus)
    }
}

/// Test double. Never used by the app.
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String: String] = [:]

    public init() {}

    public func token(for id: String) throws -> String? {
        lock.withLock { tokens[id] }
    }

    public func setToken(_ token: String, for id: String) throws {
        lock.withLock { tokens[id] = token }
    }

    public func removeToken(for id: String) throws {
        _ = lock.withLock { tokens.removeValue(forKey: id) }
    }
}
