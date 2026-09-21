import Foundation

/// One paired daemon. The token is not a field here on purpose — it lives in
/// the Keychain and is fetched by id, so a `SavedDaemon` can be logged,
/// diffed, or put in a view model without leaking a credential.
public struct SavedDaemon: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public var label: String
    public var address: DaemonAddress

    public init(id: String = UUID().uuidString, label: String, address: DaemonAddress) {
        self.id = id
        self.label = label
        self.address = address
    }
}

/// Where the daemon list is written.
///
/// A protocol rather than a `UserDefaults` parameter because `UserDefaults` is
/// not `Sendable` and so cannot cross into an actor under Swift 6 isolation —
/// and because it keeps the credential-free record separate from the Keychain
/// that holds the tokens.
public protocol DaemonRecordStore: Sendable {
    func load() -> (daemons: [SavedDaemon], activeID: String?)
    func save(daemons: [SavedDaemon], activeID: String?)
}

/// The app's real store. Holds the suite name, not the `UserDefaults` itself,
/// so the type stays `Sendable`.
public struct UserDefaultsRecordStore: DaemonRecordStore {
    private static let daemonsKey = "archductor.daemons"
    private static let activeKey = "archductor.activeDaemon"

    private let suiteName: String?

    public init(suiteName: String? = nil) {
        self.suiteName = suiteName
    }

    private var defaults: UserDefaults {
        suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard
    }

    public func load() -> (daemons: [SavedDaemon], activeID: String?) {
        let defaults = defaults
        let daemons = defaults.data(forKey: Self.daemonsKey)
            .flatMap { try? JSONDecoder().decode([SavedDaemon].self, from: $0) } ?? []
        return (daemons, defaults.string(forKey: Self.activeKey))
    }

    public func save(daemons: [SavedDaemon], activeID: String?) {
        let defaults = defaults
        defaults.set(try? JSONEncoder().encode(daemons), forKey: Self.daemonsKey)
        defaults.set(activeID, forKey: Self.activeKey)
    }
}

/// The daemons this phone knows about, and which one is active.
public actor DaemonDirectory {
    private let records: DaemonRecordStore
    private let tokens: TokenStore
    private var daemons: [SavedDaemon]
    public private(set) var activeID: String?

    public init(
        records: DaemonRecordStore = UserDefaultsRecordStore(),
        tokens: TokenStore = KeychainTokenStore()
    ) {
        self.records = records
        self.tokens = tokens
        let loaded = records.load()
        daemons = loaded.daemons
        activeID = loaded.activeID
    }

    public func all() -> [SavedDaemon] { daemons }

    public func add(label: String, address: DaemonAddress, token: String) throws -> SavedDaemon {
        let trimmed = label.trimmingCharacters(in: .whitespaces)
        let daemon = SavedDaemon(label: trimmed.isEmpty ? address.host : trimmed, address: address)
        try tokens.setToken(token, for: daemon.id)
        daemons.append(daemon)
        if activeID == nil { activeID = daemon.id }
        persist()
        return daemon
    }

    public func remove(id: String) throws {
        try tokens.removeToken(for: id)
        daemons.removeAll { $0.id == id }
        if activeID == id { activeID = daemons.first?.id }
        persist()
    }

    public func rename(id: String, to label: String) {
        guard let index = daemons.firstIndex(where: { $0.id == id }) else { return }
        daemons[index].label = label
        persist()
    }

    public func token(for id: String) throws -> String? {
        try tokens.token(for: id)
    }

    public func setActive(_ id: String?) {
        activeID = id
        persist()
    }

    public func active() -> SavedDaemon? {
        daemons.first { $0.id == activeID }
    }

    private func persist() {
        records.save(daemons: daemons, activeID: activeID)
    }
}
