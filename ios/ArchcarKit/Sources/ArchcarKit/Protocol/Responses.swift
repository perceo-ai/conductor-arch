import Foundation

/// A response the app understands, plus a catch-all.
///
/// P0 decodes only the responses P0 sends requests for. Everything else lands
/// in `.unknown`, which is deliberate: a phone on an older build must degrade
/// to "I don't render that" rather than failing to decode the line at all.
public enum ArchcarResponse: Sendable {
    case ack
    case workspaces([WorkspaceSummary])
    case repositories([RepositorySummary])
    case inventorySnapshot(repositories: [RepositorySummary], workspaces: [WorkspaceSummary])
    case remoteAccess(listen: String?, token: String)
    case error(String)
    case unknown(type: String)
}

extension ArchcarResponse: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type, workspaces, repositories, message, listen, token
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "ack":
            self = .ack
        case "workspaces":
            self = .workspaces(try container.decode([WorkspaceSummary].self, forKey: .workspaces))
        case "repositories":
            self = .repositories(try container.decode([RepositorySummary].self, forKey: .repositories))
        case "inventory_snapshot":
            self = .inventorySnapshot(
                repositories: try container.decode([RepositorySummary].self, forKey: .repositories),
                workspaces: try container.decode([WorkspaceSummary].self, forKey: .workspaces)
            )
        case "remote_access":
            self = .remoteAccess(
                listen: try container.decodeIfPresent(String.self, forKey: .listen),
                token: try container.decode(String.self, forKey: .token)
            )
        case "error":
            self = .error(try container.decode(String.self, forKey: .message))
        default:
            self = .unknown(type: type)
        }
    }
}

public struct ResponseEnvelope: Decodable, Sendable {
    public let id: String
    public let payload: ArchcarResponse
}
