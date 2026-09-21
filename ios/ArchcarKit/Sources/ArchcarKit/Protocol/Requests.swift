import Foundation

public struct ListWorkspacesRequest: ArchcarRequestBody {
    public static let typeName = "list_workspaces"
    public init() {}
}

public struct ListRepositoriesRequest: ArchcarRequestBody {
    public static let typeName = "list_repositories"
    public init() {}
}

public struct GetInventorySnapshotRequest: ArchcarRequestBody {
    public static let typeName = "get_inventory_snapshot"
    public init() {}
}

/// Legal only on a connection that sends nothing else; the daemon rejects it
/// on a shared connection.
public struct SubscribeRequest: ArchcarRequestBody {
    public static let typeName = "subscribe"
    public init() {}
}

/// The listen address and token a client needs to reach this daemon. Used by
/// the desktop pairing card; the phone never calls it against a daemon it is
/// not already paired with.
public struct GetRemoteAccessRequest: ArchcarRequestBody {
    public static let typeName = "get_remote_access"
    public init() {}
}
