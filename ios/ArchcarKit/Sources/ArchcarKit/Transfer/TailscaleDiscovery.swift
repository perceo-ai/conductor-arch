import Foundation

/// A daemon on the tailnet, as `discover_tailscale_peers` reports it. Mirrors
/// `TailscalePeer` in crates/core/src/archcar/tailscale.rs.
public struct TailscalePeer: Codable, Sendable, Hashable, Identifiable {
    public let hostName: String
    public let dnsName: String
    public let ip: String
    public let os: String
    public let archcarListener: Bool
    public let listenerPort: UInt16
    public let tailscaleSSH: Bool

    public var id: String { ip }

    /// Where the phone would connect. The phone has no SSH transport, so this
    /// is always the TCP listener: MagicDNS name when there is one, else the IP.
    public var address: DaemonAddress {
        DaemonAddress(host: dnsName.isEmpty ? ip : dnsName, port: listenerPort)
    }

    enum CodingKeys: String, CodingKey {
        case hostName = "host_name"
        case dnsName = "dns_name"
        case ip, os
        case archcarListener = "archcar_listener"
        case listenerPort = "listener_port"
        case tailscaleSSH = "tailscale_ssh"
    }
}

public enum TailscaleDiscovery {
    /// Ask a paired daemon which Archductor daemons share its tailnet.
    ///
    /// The phone cannot run `tailscale status`; the daemon can, and it is on
    /// the same tailnet. Returns only peers the phone can pair with (a TCP
    /// listener answered) and has not paired already.
    public static func suggestions(
        via session: DaemonSession, excluding saved: [SavedDaemon]
    ) async throws -> [TailscalePeer] {
        let reply = try await session.requestRaw("discover_tailscale_peers")
        if reply.type == "error" {
            let message = reply["message"]?.string ?? "discovery failed"
            // A daemon older than this request names it as unknown.
            if message.contains("unknown variant") {
                throw DaemonSessionError.daemon(
                    "This daemon is too old to look for others on Tailscale. Update it, then try again.")
            }
            throw DaemonSessionError.daemon(message)
        }
        let data = try JSONEncoder().encode(reply["peers"] ?? .array([]))
        let peers = try JSONDecoder().decode([TailscalePeer].self, from: data)
        return filter(peers, excluding: saved)
    }

    /// Listener peers that no saved daemon already points at, by any name.
    public static func filter(_ peers: [TailscalePeer], excluding saved: [SavedDaemon]) -> [TailscalePeer] {
        let savedHosts = Set(saved.map { normalize($0.address.host) })
        return peers.filter { peer in
            guard peer.archcarListener else { return false }
            let names = [peer.ip, peer.dnsName, peer.hostName].filter { !$0.isEmpty }.map(normalize)
            return !names.contains(where: savedHosts.contains)
        }
    }

    static func normalize(_ host: String) -> String {
        var host = host.lowercased()
        while host.hasSuffix(".") { host.removeLast() }
        return host
    }
}
