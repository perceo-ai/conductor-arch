//! Find Archductor daemons on this machine's tailnet so they can be suggested
//! as clients instead of typed in by hand.
//!
//! Discovery is client-side and read-only: ask the local `tailscale` CLI for
//! its peers, then for each online peer
//!
//! - probe the archcar TCP listener (default port) with a deliberately wrong
//!   token. A real archcar answers with its fixed "authentication failed"
//!   envelope, which no other service would send, so a hit is unambiguous and
//!   no credential ever leaves this machine;
//! - note whether the peer advertises Tailscale SSH, because an `ssh://`
//!   client needs neither a token nor an open port.
//!
//! A peer is suggested when either is true. SSH is preferred when available —
//! it connects in one click — and the TCP listener otherwise (that path still
//! needs the server's token). The desktop mirrors this in
//! `desktop/electron/tailscale.ts`; keep the two in step.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::remote::DEFAULT_REMOTE_PORT;

/// Sent as the "token" line of a probe. Never a valid token: real ones are
/// generated hex, and this contains spaces.
pub const PROBE_TOKEN_LINE: &str = "archductor discovery probe\n";

/// The marker the archcar listener's auth-failure envelope carries.
pub const AUTH_FAILURE_MARKER: &str = "archcar authentication failed";

/// Per-peer probe budget. Tailnet RTTs are tens of milliseconds; a peer that
/// takes longer than this to answer is not one to suggest.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(900);

/// How a suggested peer would be connected to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    /// `ssh://host` — no token, nothing listening.
    Ssh,
    /// `host:port` against the token-guarded listener.
    Tcp,
}

/// One tailnet peer worth offering as a client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TailscalePeer {
    pub host_name: String,
    /// MagicDNS name without the trailing dot; empty when MagicDNS is off.
    pub dns_name: String,
    /// First Tailscale IPv4 (100.x), else the first address.
    pub ip: String,
    pub os: String,
    /// An archcar listener answered on `listener_port`.
    pub archcar_listener: bool,
    pub listener_port: u16,
    /// The peer advertises Tailscale SSH host keys.
    pub tailscale_ssh: bool,
    pub transport: Transport,
    /// What to pass to `remote connect` / the Add client form.
    pub suggested_address: String,
    /// The suggested address is TCP and so still needs the server's token.
    pub needs_token: bool,
    /// A saved client already points at this peer.
    pub saved: bool,
}

/// The fields of `tailscale status --json` this module reads.
#[derive(Debug, Default, Deserialize)]
struct Status {
    #[serde(rename = "BackendState", default)]
    backend_state: String,
    #[serde(rename = "Peer", default)]
    peer: Option<std::collections::BTreeMap<String, RawPeer>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawPeer {
    #[serde(rename = "HostName", default)]
    pub host_name: String,
    #[serde(rename = "DNSName", default)]
    pub dns_name: String,
    #[serde(rename = "OS", default)]
    pub os: String,
    #[serde(rename = "TailscaleIPs", default)]
    pub tailscale_ips: Vec<String>,
    #[serde(rename = "Online", default)]
    pub online: bool,
    #[serde(rename = "sshHostKeys", default)]
    pub ssh_host_keys: Option<Vec<String>>,
}

impl RawPeer {
    fn ip(&self) -> Option<String> {
        self.tailscale_ips
            .iter()
            .find(|ip| ip.contains('.'))
            .or_else(|| self.tailscale_ips.first())
            .cloned()
    }

    fn dns(&self) -> String {
        self.dns_name.trim_end_matches('.').to_owned()
    }
}

/// Peers that could host a daemon: online, not a phone, with an address.
/// Sorted by host name so output is stable.
pub fn parse_status(json: &str) -> Result<Vec<RawPeer>> {
    let status: Status = serde_json::from_str(json).context("parse `tailscale status --json`")?;
    if !status.backend_state.is_empty() && status.backend_state != "Running" {
        anyhow::bail!(
            "Tailscale is not connected on this machine (state: {})",
            status.backend_state
        );
    }
    let mut peers: Vec<RawPeer> = status
        .peer
        .unwrap_or_default()
        .into_values()
        .filter(|p| p.online && p.ip().is_some())
        .filter(|p| !matches!(p.os.to_ascii_lowercase().as_str(), "ios" | "android"))
        .collect();
    peers.sort_by_key(|p| p.host_name.to_lowercase());
    Ok(peers)
}

/// Build the suggestion for a probed peer, or `None` when there is no way in.
pub fn suggest(
    raw: &RawPeer,
    archcar_listener: bool,
    port: u16,
    saved_addresses: &[String],
) -> Option<TailscalePeer> {
    let ip = raw.ip()?;
    let dns_name = raw.dns();
    let tailscale_ssh = raw.ssh_host_keys.as_ref().is_some_and(|k| !k.is_empty());
    if !archcar_listener && !tailscale_ssh {
        return None;
    }
    // An IPv6 literal is bracketed, or its last group reads as a port.
    let host = if !dns_name.is_empty() {
        dns_name.clone()
    } else if ip.contains(':') {
        format!("[{ip}]")
    } else {
        ip.clone()
    };
    let (transport, suggested_address) = if tailscale_ssh {
        (Transport::Ssh, format!("ssh://{host}"))
    } else {
        (Transport::Tcp, format!("{host}:{port}"))
    };
    let names = [ip.as_str(), dns_name.as_str(), raw.host_name.as_str()];
    let saved = saved_addresses.iter().any(|address| {
        let saved_host = address_host(address);
        !saved_host.is_empty()
            && names
                .iter()
                .any(|name| !name.is_empty() && name.eq_ignore_ascii_case(&saved_host))
    });
    Some(TailscalePeer {
        host_name: raw.host_name.clone(),
        dns_name,
        ip,
        os: raw.os.clone(),
        archcar_listener,
        listener_port: port,
        tailscale_ssh,
        needs_token: transport == Transport::Tcp,
        transport,
        suggested_address,
        saved,
    })
}

/// The bare host of a client address: drops `ssh://`, `user@`, `:port`, and a
/// trailing path, and the trailing dot of a FQDN.
pub fn address_host(address: &str) -> String {
    let rest = address.trim();
    let rest = rest.strip_prefix(super::remote::SSH_SCHEME).unwrap_or(rest);
    let rest = rest.split('/').next().unwrap_or_default();
    let rest = rest.rsplit('@').next().unwrap_or_default();
    let host = if let Some(bracketed) = rest.strip_prefix('[') {
        bracketed.split(']').next().unwrap_or_default()
    } else {
        match rest.rsplit_once(':') {
            Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
            _ => rest,
        }
    };
    host.trim_end_matches('.').to_owned()
}

/// Whether an archcar listener answers at `addr`. Sends a wrong token and looks
/// for the listener's fixed rejection; anything else is "no".
pub fn probe_archcar(addr: &str, timeout: Duration) -> bool {
    let Some(socket) = addr
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
    else {
        return false;
    };
    probe_socket(socket, timeout).unwrap_or(false)
}

fn probe_socket(socket: SocketAddr, timeout: Duration) -> std::io::Result<bool> {
    let mut stream = TcpStream::connect_timeout(&socket, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(PROBE_TOKEN_LINE.as_bytes())?;
    stream.flush()?;
    // One line, capped, so a chatty non-archcar service cannot stall us.
    let mut line = String::new();
    BufReader::new(stream.take(1024)).read_line(&mut line)?;
    Ok(line.contains(AUTH_FAILURE_MARKER))
}

/// Where the `tailscale` CLI might be. macOS app installs do not put it on
/// PATH.
const TAILSCALE_CANDIDATES: [&str; 2] = [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/// Run `tailscale status --json`.
pub fn status_json() -> Result<String> {
    let mut last_error = None;
    for program in TAILSCALE_CANDIDATES {
        match Command::new(program).args(["status", "--json"]).output() {
            Ok(output) if output.status.success() => {
                return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                last_error = Some(anyhow::anyhow!(
                    "`tailscale status` failed: {}",
                    if stderr.is_empty() {
                        "no output"
                    } else {
                        stderr.as_str()
                    }
                ));
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => last_error = Some(err.into()),
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("the `tailscale` CLI is not installed")))
}

/// Discover suggestable peers. Probes run in parallel, one thread per peer.
pub fn discover(port: Option<u16>, saved_addresses: &[String]) -> Result<Vec<TailscalePeer>> {
    let port = port.unwrap_or(DEFAULT_REMOTE_PORT);
    let peers = parse_status(&status_json()?)?;
    let handles: Vec<_> = peers
        .into_iter()
        .map(|peer| {
            std::thread::spawn(move || {
                let listener = peer
                    .ip()
                    .map(|ip| probe_archcar(&format_host_port(&ip, port), PROBE_TIMEOUT))
                    .unwrap_or(false);
                (peer, listener)
            })
        })
        .collect();
    Ok(handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .filter_map(|(peer, listener)| suggest(&peer, listener, port, saved_addresses))
        .collect())
}

fn format_host_port(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    const STATUS: &str = r#"{
      "BackendState": "Running",
      "Self": {"HostName": "laptop", "Online": true, "TailscaleIPs": ["100.64.0.1"]},
      "Peer": {
        "nodekey:a": {"HostName": "devbox", "DNSName": "devbox.tail1.ts.net.", "OS": "linux",
                      "TailscaleIPs": ["fd7a::2", "100.64.0.2"], "Online": true,
                      "sshHostKeys": ["ssh-ed25519 AAAA"]},
        "nodekey:b": {"HostName": "Builder", "DNSName": "builder.tail1.ts.net.", "OS": "linux",
                      "TailscaleIPs": ["100.64.0.3"], "Online": true},
        "nodekey:c": {"HostName": "phone", "OS": "iOS", "TailscaleIPs": ["100.64.0.4"], "Online": true},
        "nodekey:d": {"HostName": "asleep", "OS": "linux", "TailscaleIPs": ["100.64.0.5"], "Online": false}
      }
    }"#;

    #[test]
    fn parse_keeps_online_non_mobile_peers_sorted() {
        let peers = parse_status(STATUS).unwrap();
        let names: Vec<_> = peers.iter().map(|p| p.host_name.as_str()).collect();
        assert_eq!(names, ["Builder", "devbox"]);
        assert_eq!(peers[1].ip().as_deref(), Some("100.64.0.2"));
    }

    #[test]
    fn parse_refuses_a_stopped_tailnet() {
        let err = parse_status(r#"{"BackendState":"Stopped"}"#).unwrap_err();
        assert!(err.to_string().contains("not connected"));
    }

    #[test]
    fn ssh_is_preferred_and_tcp_needs_a_token() {
        let peers = parse_status(STATUS).unwrap();
        let devbox = suggest(&peers[1], true, 7420, &[]).unwrap();
        assert_eq!(devbox.transport, Transport::Ssh);
        assert_eq!(devbox.suggested_address, "ssh://devbox.tail1.ts.net");
        assert!(!devbox.needs_token);

        let builder = suggest(&peers[0], true, 7420, &[]).unwrap();
        assert_eq!(builder.transport, Transport::Tcp);
        assert_eq!(builder.suggested_address, "builder.tail1.ts.net:7420");
        assert!(builder.needs_token);

        // No listener and no Tailscale SSH: nothing to offer.
        assert!(suggest(&peers[0], false, 7420, &[]).is_none());
    }

    #[test]
    fn saved_matches_any_name_form() {
        let peers = parse_status(STATUS).unwrap();
        for saved in [
            "ssh://me@devbox.tail1.ts.net:22/opt/archductor",
            "100.64.0.2:7420",
            "DEVBOX:7420",
            "devbox.tail1.ts.net.:7420",
        ] {
            let peer = suggest(&peers[1], false, 7420, &[saved.to_owned()]).unwrap();
            assert!(peer.saved, "{saved} should match devbox");
        }
        let peer = suggest(&peers[1], false, 7420, &["builder:7420".to_owned()]).unwrap();
        assert!(!peer.saved);
    }

    #[test]
    fn ipv6_only_peers_get_a_bracketed_address() {
        let raw = RawPeer {
            host_name: "v6box".into(),
            tailscale_ips: vec!["fd7a::2".into()],
            online: true,
            ssh_host_keys: Some(vec!["k".into()]),
            ..RawPeer::default()
        };
        assert_eq!(
            suggest(&raw, true, 7420, &[]).unwrap().suggested_address,
            "ssh://[fd7a::2]"
        );
        let tcp = RawPeer {
            ssh_host_keys: None,
            ..raw
        };
        assert_eq!(
            suggest(&tcp, true, 7420, &[]).unwrap().suggested_address,
            "[fd7a::2]:7420"
        );
    }

    #[test]
    fn address_host_strips_every_decoration() {
        assert_eq!(address_host("ssh://u@h.example:2222/bin/a"), "h.example");
        assert_eq!(address_host("h:7420"), "h");
        assert_eq!(address_host("[fd7a::2]:7420"), "fd7a::2");
        assert_eq!(address_host("plainhost"), "plainhost");
    }

    #[test]
    fn probe_recognises_a_real_listener_and_rejects_others() {
        // A real archcar listener: the auth path under test.
        let listener = super::super::remote::bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = std::thread::spawn(move || {
            super::super::remote::accept_authenticated(&listener, "real-token").unwrap()
        });
        assert!(probe_archcar(&addr, Duration::from_secs(2)));
        assert!(server.join().unwrap().is_none());

        // Some other service that answers with something else.
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let other_addr = other.local_addr().unwrap().to_string();
        std::thread::spawn(move || {
            let (mut s, _) = other.accept().unwrap();
            let _ = s.write_all(b"SSH-2.0-OpenSSH_9.9\r\n");
        });
        assert!(!probe_archcar(&other_addr, Duration::from_secs(2)));

        // Nothing listening.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_addr = closed.local_addr().unwrap().to_string();
        drop(closed);
        assert!(!probe_archcar(&closed_addr, Duration::from_millis(300)));
    }
}
