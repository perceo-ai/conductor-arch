//! Remote archcar access: a TCP listener guarded by a shared token.
//!
//! The local endpoint (Unix socket / loopback named pipe) stays the default and
//! is protected by filesystem permissions. The TCP listener is what lets a
//! client reach the daemon from another machine without depending on a mesh VPN
//! — it is opt-in, defaults to loopback, and every connection must present the
//! token as its first line before any RPC is read.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use uuid::Uuid;

use crate::paths::AppPaths;

/// Default port for the archcar TCP listener.
pub const DEFAULT_REMOTE_PORT: u16 = 7420;

/// How long a connecting client has to present its token.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Refuse absurd handshake lines rather than buffering them.
const MAX_TOKEN_BYTES: usize = 512;

/// Rejection payload, shaped like `RpcEnvelope<ArchcarResponse>` so existing
/// clients surface the reason instead of a JSON decode failure. Deliberately
/// says nothing about how wrong the token was.
const AUTH_FAILURE_LINE: &str =
    "{\"id\":\"auth\",\"payload\":{\"type\":\"error\",\"message\":\"archcar authentication failed\"}}\n";

/// Environment overrides, so a service unit can configure the listener without
/// a config file.
pub const LISTEN_ENV: &str = "ARCHDUCTOR_ARCHCAR_LISTEN";
/// Client-side: `host:port` of a remote archcar to talk to instead of the local
/// endpoint.
pub const REMOTE_ENV: &str = "ARCHDUCTOR_ARCHCAR_REMOTE";
/// Client-side: the token to present. Falls back to the local token file.
pub const TOKEN_ENV: &str = "ARCHDUCTOR_ARCHCAR_TOKEN";

pub fn token_path(paths: &AppPaths) -> PathBuf {
    paths.state_dir.join("archcar.token")
}

/// Client-side connection profile for a server-hosted daemon, persisted so the
/// CLI and the desktop app can stay pointed at a remote archcar across
/// restarts without environment variables. Environment overrides still win.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RemoteProfile {
    /// `host:port` of the remote archcar TCP listener.
    pub address: String,
    /// Access token the daemon expects as the first line of every connection.
    pub token: String,
}

pub fn profile_path(paths: &AppPaths) -> PathBuf {
    paths.state_dir.join("remote.json")
}

/// Persist the remote profile (owner-only: it contains the token).
pub fn save_profile(paths: &AppPaths, profile: &RemoteProfile) -> Result<()> {
    anyhow::ensure!(
        !profile.address.trim().is_empty(),
        "remote address is required"
    );
    anyhow::ensure!(!profile.token.trim().is_empty(), "remote token is required");
    std::fs::create_dir_all(&paths.state_dir)
        .with_context(|| format!("create archcar state dir {}", paths.state_dir.display()))?;
    let path = profile_path(paths);
    let body = serde_json::to_string_pretty(profile)?;
    std::fs::write(&path, format!("{body}\n"))
        .with_context(|| format!("write remote profile {}", path.display()))?;
    restrict_to_owner(&path)?;
    Ok(())
}

pub fn load_profile(paths: &AppPaths) -> Result<Option<RemoteProfile>> {
    let path = profile_path(paths);
    match std::fs::read_to_string(&path) {
        Ok(contents) => {
            let profile: RemoteProfile = serde_json::from_str(&contents)
                .with_context(|| format!("parse remote profile {}", path.display()))?;
            if profile.address.trim().is_empty() || profile.token.trim().is_empty() {
                return Ok(None);
            }
            Ok(Some(profile))
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("read remote profile {}", path.display())),
    }
}

/// Remove the remote profile. Returns whether one existed.
pub fn clear_profile(paths: &AppPaths) -> Result<bool> {
    let path = profile_path(paths);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err).with_context(|| format!("remove remote profile {}", path.display())),
    }
}

/// Read the access token, creating one on first use. The file is owner-only:
/// anyone who can read it can drive every workspace on this machine.
pub fn ensure_token(paths: &AppPaths) -> Result<String> {
    let path = token_path(paths);
    if let Some(existing) = read_token(&path)? {
        return Ok(existing);
    }
    std::fs::create_dir_all(&paths.state_dir)
        .with_context(|| format!("create archcar state dir {}", paths.state_dir.display()))?;
    let token = generate_token();
    write_token(&path, &token)?;
    Ok(token)
}

pub fn read_token(path: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(contents) => {
            let token = contents.trim().to_owned();
            Ok((!token.is_empty()).then_some(token))
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("read archcar token {}", path.display())),
    }
}

/// Replace the token, invalidating every client that still holds the old one.
pub fn rotate_token(paths: &AppPaths) -> Result<String> {
    std::fs::create_dir_all(&paths.state_dir)?;
    let token = generate_token();
    write_token(&token_path(paths), &token)?;
    Ok(token)
}

fn write_token(path: &Path, token: &str) -> Result<()> {
    std::fs::write(path, format!("{token}\n"))
        .with_context(|| format!("write archcar token {}", path.display()))?;
    restrict_to_owner(path)?;
    Ok(())
}

fn generate_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("restrict archcar token {}", path.display()))
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> Result<()> {
    // Windows inherits the state directory's ACL; there is no portable chmod.
    Ok(())
}

/// Parse a listen address. A bare port or `:port` means loopback, which is the
/// safe default: opening to the network has to be spelled out.
pub fn parse_listen_addr(value: &str) -> Result<SocketAddr> {
    let value = value.trim();
    anyhow::ensure!(!value.is_empty(), "listen address is required");
    if let Ok(port) = value.trim_start_matches(':').parse::<u16>() {
        return Ok(SocketAddr::from(([127, 0, 0, 1], port)));
    }
    value
        .to_socket_addrs()
        .with_context(|| format!("resolve archcar listen address `{value}`"))?
        .next()
        .with_context(|| format!("archcar listen address `{value}` resolved to nothing"))
}

/// True when the address is reachable from outside this machine. Callers log a
/// warning for these, since the token is then the only thing in the way.
pub fn is_public_addr(addr: &SocketAddr) -> bool {
    !addr.ip().is_loopback()
}

/// The listen address from the environment, if the operator asked for one.
pub fn listen_addr_from_env() -> Option<Result<SocketAddr>> {
    std::env::var(LISTEN_ENV)
        .ok()
        .map(|value| parse_listen_addr(&value))
}

pub fn bind(addr: SocketAddr) -> Result<TcpListener> {
    TcpListener::bind(addr).with_context(|| format!("bind archcar tcp listener on {addr}"))
}

/// Accept one connection and check its token line. Returns `Ok(None)` when the
/// client failed the handshake, so the caller keeps serving instead of dying.
pub fn accept_authenticated(
    listener: &TcpListener,
    expected_token: &str,
) -> io::Result<Option<(TcpStream, SocketAddr)>> {
    let (mut stream, peer) = listener.accept()?;
    // The listener may be non-blocking; the accepted stream must not be, since
    // the handshake relies on a read timeout.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    let Some(token) = read_token_line(&mut stream)? else {
        return Ok(None);
    };
    if !constant_time_eq(&token, expected_token) {
        // Reply in the envelope shape every client already parses, so the
        // failure reads as "authentication failed" and not as a decode error.
        let _ = stream.write_all(AUTH_FAILURE_LINE.as_bytes());
        return Ok(None);
    }
    stream.set_read_timeout(None)?;
    Ok(Some((stream, peer)))
}

/// Read exactly the token line, one byte at a time. A buffered reader would
/// swallow the RPC line that follows on the same connection.
fn read_token_line(stream: &mut TcpStream) -> io::Result<Option<String>> {
    let mut token = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => return Ok(None),
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => {
                token.push(byte[0]);
                if token.len() > MAX_TOKEN_BYTES {
                    return Ok(None);
                }
            }
            Err(_) => return Ok(None),
        }
    }
    Ok(Some(
        String::from_utf8_lossy(&token)
            .trim_end_matches('\r')
            .to_owned(),
    ))
}

/// Open an authenticated connection to a remote archcar.
pub fn connect(addr: &str, token: &str) -> Result<TcpStream> {
    let mut stream =
        TcpStream::connect(addr).with_context(|| format!("connect to archcar at {addr}"))?;
    stream.write_all(token.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;
    Ok(stream)
}

/// Compare without an early exit on the first differing byte.
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0_u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn paths_in(dir: &Path) -> AppPaths {
        AppPaths {
            config_dir: dir.join("config"),
            data_dir: dir.join("data"),
            state_dir: dir.join("state"),
            cache_dir: dir.join("cache"),
            database_path: dir.join("data/archductor.db"),
            logs_dir: dir.join("state/logs"),
        }
    }

    #[test]
    fn token_is_created_once_and_reused() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());

        let first = ensure_token(&paths).unwrap();
        let second = ensure_token(&paths).unwrap();

        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert_eq!(
            read_token(&token_path(&paths)).unwrap().as_deref(),
            Some(first.as_str())
        );

        let rotated = rotate_token(&paths).unwrap();
        assert_ne!(rotated, first);
    }

    #[cfg(unix)]
    #[test]
    fn token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());
        ensure_token(&paths).unwrap();

        let mode = std::fs::metadata(token_path(&paths))
            .unwrap()
            .permissions()
            .mode();

        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn saved_profile_resolves_to_a_remote_endpoint() {
        use crate::archcar::client::{configured_remote_endpoint, ArchcarEndpoint};
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());

        // No env, no profile: local daemon.
        assert!(configured_remote_endpoint(&paths).unwrap().is_none());

        save_profile(
            &paths,
            &RemoteProfile {
                address: "devbox:7420".to_owned(),
                token: "tok-abc".to_owned(),
            },
        )
        .unwrap();
        let endpoint = configured_remote_endpoint(&paths).unwrap().unwrap();
        match endpoint {
            ArchcarEndpoint::Remote { address, token } => {
                assert_eq!(address, "devbox:7420");
                assert_eq!(token, "tok-abc");
            }
            other => panic!("expected remote endpoint, got {other:?}"),
        }
    }

    #[test]
    fn remote_profile_round_trips_and_clears() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());

        assert!(load_profile(&paths).unwrap().is_none());

        let profile = RemoteProfile {
            address: "devbox:7420".to_owned(),
            token: "tok-123".to_owned(),
        };
        save_profile(&paths, &profile).unwrap();
        assert_eq!(load_profile(&paths).unwrap(), Some(profile));

        // Owner-only: the file holds the access token.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(profile_path(&paths))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        assert!(clear_profile(&paths).unwrap());
        assert!(!clear_profile(&paths).unwrap());
        assert!(load_profile(&paths).unwrap().is_none());

        // Empty fields are rejected on save and treated as absent on load.
        let err = save_profile(
            &paths,
            &RemoteProfile {
                address: " ".to_owned(),
                token: "x".to_owned(),
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("address"), "{err}");
    }

    #[test]
    fn listen_addresses_default_to_loopback() {
        assert_eq!(
            parse_listen_addr("7420").unwrap(),
            SocketAddr::from(([127, 0, 0, 1], 7420))
        );
        assert_eq!(
            parse_listen_addr(":9000").unwrap(),
            SocketAddr::from(([127, 0, 0, 1], 9000))
        );
        assert_eq!(
            parse_listen_addr("0.0.0.0:7420").unwrap(),
            SocketAddr::from(([0, 0, 0, 0], 7420))
        );
        assert!(parse_listen_addr("  ").is_err());

        assert!(!is_public_addr(&parse_listen_addr("7420").unwrap()));
        assert!(is_public_addr(&parse_listen_addr("0.0.0.0:7420").unwrap()));
    }

    #[test]
    fn a_correct_token_is_accepted_and_a_wrong_one_is_refused() {
        let listener = bind(parse_listen_addr("127.0.0.1:0").unwrap()).unwrap();
        let addr = listener.local_addr().unwrap();
        let token = "correct-horse".to_owned();

        let server_token = token.clone();
        let server = std::thread::spawn(move || {
            // First connection presents a bad token, second a good one.
            assert!(accept_authenticated(&listener, &server_token)
                .unwrap()
                .is_none());
            let (mut stream, _) = accept_authenticated(&listener, &server_token)
                .unwrap()
                .expect("authenticated connection");
            // The handshake must not swallow bytes the client pipelined behind
            // the token line.
            let mut byte = [0_u8; 4];
            stream.read_exact(&mut byte).unwrap();
            assert_eq!(&byte, b"ping");
            stream.write_all(b"pong").unwrap();
        });

        let mut rejected = connect(&addr.to_string(), "wrong-token").unwrap();
        let mut refusal = String::new();
        rejected.read_to_string(&mut refusal).unwrap();
        assert!(refusal.contains("authentication failed"), "{refusal}");
        // The refusal must decode as a normal RPC error response.
        let value: serde_json::Value = serde_json::from_str(refusal.trim()).unwrap();
        assert_eq!(value["payload"]["type"], "error");
        assert!(value["id"].is_string());

        // Write the token and the payload in one burst, the way a real client
        // pipelines its first RPC.
        let mut accepted = TcpStream::connect(addr).unwrap();
        accepted
            .write_all(format!("{token}\nping").as_bytes())
            .unwrap();
        accepted.flush().unwrap();
        let mut reply = [0_u8; 4];
        accepted.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"pong");

        server.join().unwrap();
    }

    #[test]
    fn constant_time_comparison_still_compares() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }
}
