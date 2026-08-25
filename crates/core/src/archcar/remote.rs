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
use std::sync::{Arc, Mutex};
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

// --- SSH transport -------------------------------------------------------
//
// The TCP listener sends a shared bearer token in cleartext and gives every
// client the same identity, so it is only safe on loopback or a network you
// already trust. SSH is the alternative that needs no new credential: the
// client runs `ssh <host> archductor archcar stdio-proxy`, the server end
// connects to its own local socket, and the two pump bytes at each other. The
// connection is encrypted by sshd, the identity is the SSH key, revocation is
// `authorized_keys`, and no port is open on the daemon at all.
//
// This is the same shape as `git` over ssh and `docker -H ssh://`.

pub const SSH_SCHEME: &str = "ssh://";
/// What the client runs on the far side. Kept here so the client and the docs
/// cannot drift from the subcommand that implements it.
pub const SSH_PROXY_ARGS: [&str; 3] = ["archcar", "stdio-proxy", "--quiet"];

/// A daemon reached by running the stdio proxy over SSH.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    /// `[user@]host` — handed to `ssh` verbatim, so `~/.ssh/config` aliases,
    /// jump hosts, and per-host identities all keep working.
    pub destination: String,
    pub port: Option<u16>,
    /// The `archductor` executable on the far side. `ssh host <command>` runs a
    /// non-interactive shell, which on many systems skips the profile that adds
    /// `~/.local/bin` to PATH — so an explicit path is worth allowing.
    pub program: String,
}

impl SshTarget {
    /// The full argument list for `ssh`.
    pub fn ssh_args(&self) -> Vec<String> {
        let mut args = vec![
            // No pty: this is a byte pipe, and a pty would mangle it with echo
            // and CR translation.
            "-T".to_owned(),
            // Notice a dead peer instead of blocking forever on a read; the
            // pipe cannot carry a socket read timeout.
            "-o".to_owned(),
            "ServerAliveInterval=15".to_owned(),
            "-o".to_owned(),
            "ServerAliveCountMax=3".to_owned(),
            // A prompt would hang a background client with no terminal.
            "-o".to_owned(),
            "BatchMode=yes".to_owned(),
        ];
        if let Some(port) = self.port {
            args.push("-p".to_owned());
            args.push(port.to_string());
        }
        args.push(self.destination.clone());
        args.push(self.program.clone());
        args.extend(SSH_PROXY_ARGS.iter().map(|arg| (*arg).to_owned()));
        args
    }

    pub fn to_address(&self) -> String {
        let mut address = format!("{SSH_SCHEME}{}", self.destination);
        if let Some(port) = self.port {
            address.push_str(&format!(":{port}"));
        }
        if self.program != DEFAULT_SSH_PROGRAM {
            address.push('/');
            address.push_str(self.program.trim_start_matches('/'));
        }
        address
    }
}

const DEFAULT_SSH_PROGRAM: &str = "archductor";

/// Parse `ssh://[user@]host[:port][/path/to/archductor]`.
///
/// Returns `None` for anything that is not an `ssh://` address, so callers can
/// use it to tell the two transports apart.
pub fn parse_ssh_address(value: &str) -> Option<Result<SshTarget>> {
    let rest = value.trim().strip_prefix(SSH_SCHEME)?;
    Some(parse_ssh_rest(rest))
}

fn parse_ssh_rest(rest: &str) -> Result<SshTarget> {
    anyhow::ensure!(!rest.is_empty(), "ssh address needs a host");
    // The first `/` after the authority starts the program path. An IPv6
    // literal is bracketed, so it cannot contain a bare `/`.
    let (authority, program) = match rest.find('/') {
        Some(index) => (&rest[..index], Some(&rest[index..])),
        None => (rest, None),
    };
    anyhow::ensure!(!authority.is_empty(), "ssh address needs a host");

    let (destination, port) = split_ssh_port(authority)?;
    anyhow::ensure!(
        !destination.is_empty(),
        "ssh address `{rest}` has no host part"
    );
    let program = program
        .map(str::trim)
        .filter(|program| !program.is_empty() && *program != "/")
        .unwrap_or(DEFAULT_SSH_PROGRAM)
        .to_owned();
    Ok(SshTarget {
        destination: destination.to_owned(),
        port,
        program,
    })
}

/// Split a trailing `:port`, leaving bracketed IPv6 literals alone.
fn split_ssh_port(authority: &str) -> Result<(&str, Option<u16>)> {
    if authority.ends_with(']') {
        return Ok((authority, None));
    }
    let Some(index) = authority.rfind(':') else {
        return Ok((authority, None));
    };
    let port = authority[index + 1..].parse::<u16>().with_context(|| {
        format!(
            "ssh address port `{}` is not a port",
            &authority[index + 1..]
        )
    })?;
    Ok((&authority[..index], Some(port)))
}

/// True when a saved address names the SSH transport rather than the TCP one.
pub fn is_ssh_address(value: &str) -> bool {
    value.trim().starts_with(SSH_SCHEME)
}

/// A byte pipe to a remote archcar, carried by an `ssh` child process.
pub struct SshStream {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
    /// ssh writes its own failures here — "Could not resolve hostname",
    /// "Permission denied (publickey)", "command not found". Drained on a
    /// thread so a full pipe cannot deadlock the transfer, and reported when
    /// the stream ends early so the caller sees the reason instead of EOF.
    stderr: Arc<Mutex<String>>,
}

impl SshStream {
    fn failure(&mut self) -> io::Error {
        // Wait for ssh before reading its stderr. The drain thread is still
        // running at the moment stdout hits EOF, so reading immediately races
        // it and tends to catch only the "Permanently added ... to the list of
        // known hosts" warning — hiding the "Permission denied (publickey)"
        // that is the actual reason.
        let status = wait_briefly(&mut self.child);
        let detail = self
            .stderr
            .lock()
            .map(|text| ssh_failure_reason(&text))
            .unwrap_or_default();
        let message = match (detail.is_empty(), status) {
            (false, _) => format!("ssh transport failed: {detail}"),
            (true, Some(status)) => format!("ssh exited with {status} before the daemon answered"),
            (true, None) => "ssh transport closed unexpectedly".to_owned(),
        };
        io::Error::new(io::ErrorKind::BrokenPipe, message)
    }
}

/// Reap the child, but never block the error path forever. `wait()` would hang
/// if ssh somehow closed stdout while still running, and this only exists to
/// let the stderr drain finish.
fn wait_briefly(child: &mut std::process::Child) -> Option<std::process::ExitStatus> {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // The drain thread may still be flushing the last of stderr.
                std::thread::sleep(Duration::from_millis(20));
                return Some(status);
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => return None,
        }
    }
}

/// Pick the line worth showing out of ssh's stderr.
///
/// ssh prefixes routine noise — host-key warnings, banners — ahead of the real
/// failure, and showing the first line reliably shows the wrong one.
fn ssh_failure_reason(stderr: &str) -> String {
    let interesting: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with("Warning: Permanently added"))
        .collect();
    if interesting.is_empty() {
        return stderr.trim().to_owned();
    }
    interesting.join("; ")
}

impl Drop for SshStream {
    fn drop(&mut self) {
        // The proxy exits when its stdin closes; kill only if it does not.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Read for SshStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.stdout.read(buf) {
            // A clean EOF here means ssh went away mid-conversation, which is
            // an error for a request/response transport, not an end of input.
            Ok(0) => Err(self.failure()),
            other => other,
        }
    }
}

impl Write for SshStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.stdin.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stdin.flush()
    }
}

/// Start `ssh <host> archductor archcar stdio-proxy` and hand back its pipes.
pub fn connect_ssh(target: &SshTarget) -> Result<SshStream> {
    let mut command = std::process::Command::new("ssh");
    command
        .args(target.ssh_args())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().with_context(|| {
        format!(
            "run ssh for {} (is the OpenSSH client installed?)",
            target.destination
        )
    })?;
    let stdin = child.stdin.take().context("ssh stdin was not captured")?;
    let stdout = child.stdout.take().context("ssh stdout was not captured")?;
    let mut child_stderr = child.stderr.take().context("ssh stderr was not captured")?;

    let stderr = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&stderr);
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = child_stderr.read_to_end(&mut buffer);
        if let Ok(mut text) = sink.lock() {
            text.push_str(&String::from_utf8_lossy(&buffer));
        }
    });

    Ok(SshStream {
        child,
        stdin,
        stdout,
        stderr,
    })
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
    // An ssh:// address has no token by design; sshd is the authentication.
    anyhow::ensure!(
        is_ssh_address(&profile.address) || !profile.token.trim().is_empty(),
        "remote token is required"
    );
    std::fs::create_dir_all(&paths.state_dir)
        .with_context(|| format!("create archcar state dir {}", paths.state_dir.display()))?;
    let path = profile_path(paths);
    let body = serde_json::to_string_pretty(profile)?;
    std::fs::write(&path, format!("{body}\n"))
        .with_context(|| format!("write remote profile {}", path.display()))?;
    restrict_to_owner(&path)?;
    Ok(())
}

/// A saved connection is usable when it names a host, and — for the TCP
/// transport only — carries the token that transport needs. An `ssh://` entry
/// with a blank token is complete, not half-written.
fn profile_is_usable(address: &str, token: &str) -> bool {
    !address.trim().is_empty() && (is_ssh_address(address) || !token.trim().is_empty())
}

pub fn load_profile(paths: &AppPaths) -> Result<Option<RemoteProfile>> {
    let path = profile_path(paths);
    match std::fs::read_to_string(&path) {
        Ok(contents) => {
            let profile: RemoteProfile = serde_json::from_str(&contents)
                .with_context(|| format!("parse remote profile {}", path.display()))?;
            if !profile_is_usable(&profile.address, &profile.token) {
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

// --- Saved clients -------------------------------------------------------
//
// A machine can hold any number of daemons it knows how to reach, with one of
// them active. The active one is mirrored into `remote.json` on every change,
// so `configured_remote_endpoint` — and therefore every CLI command, the
// desktop bridge, and MCP — keeps reading a single file and needs no knowledge
// of the list. `clients.json` is the list; `remote.json` is the selection.

/// One saved daemon this machine can point at.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ClientProfile {
    /// Stable key used by `remote use` and the desktop switcher.
    pub id: String,
    /// Human name shown in the UI; defaults to the address.
    pub label: String,
    pub address: String,
    pub token: String,
}

/// The saved-client list plus which one is selected. No active id means this
/// machine's local daemon.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ClientsFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_id: Option<String>,
    #[serde(default)]
    pub clients: Vec<ClientProfile>,
}

impl ClientsFile {
    pub fn active(&self) -> Option<&ClientProfile> {
        let id = self.active_id.as_deref()?;
        self.clients.iter().find(|client| client.id == id)
    }

    /// Find by id first, then by exact label, then case-insensitively — so
    /// `remote use devbox` works for a client labelled "Devbox".
    pub fn find(&self, key: &str) -> Option<&ClientProfile> {
        let key = key.trim();
        self.clients
            .iter()
            .find(|c| c.id == key)
            .or_else(|| self.clients.iter().find(|c| c.label == key))
            .or_else(|| {
                self.clients
                    .iter()
                    .find(|c| c.label.eq_ignore_ascii_case(key) || c.id.eq_ignore_ascii_case(key))
            })
    }

    /// Add or update by address — reconnecting to a known daemon should refresh
    /// its token rather than accumulate duplicates. Returns the client's id.
    pub fn upsert(&mut self, label: Option<&str>, address: &str, token: &str) -> String {
        let address = address.trim().to_owned();
        let token = token.trim().to_owned();
        if let Some(existing) = self.clients.iter_mut().find(|c| c.address == address) {
            existing.token = token;
            if let Some(label) = label.map(str::trim).filter(|l| !l.is_empty()) {
                existing.label = label.to_owned();
            }
            return existing.id.clone();
        }
        let label = label
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .unwrap_or(&address)
            .to_owned();
        let id = self.unique_id(&client_id_from(&label));
        self.clients.push(ClientProfile {
            id: id.clone(),
            label,
            address,
            token,
        });
        id
    }

    /// Remove by id or label. Clears the selection when the active one goes.
    pub fn remove(&mut self, key: &str) -> bool {
        let Some(id) = self.find(key).map(|c| c.id.clone()) else {
            return false;
        };
        self.clients.retain(|c| c.id != id);
        if self.active_id.as_deref() == Some(id.as_str()) {
            self.active_id = None;
        }
        true
    }

    fn unique_id(&self, base: &str) -> String {
        if !self.clients.iter().any(|c| c.id == base) {
            return base.to_owned();
        }
        (2..)
            .map(|n| format!("{base}-{n}"))
            .find(|candidate| !self.clients.iter().any(|c| &c.id == candidate))
            .expect("an unused suffix always exists")
    }
}

/// Slug for a label: lowercase, non-alphanumerics collapsed to single dashes.
fn client_id_from(label: &str) -> String {
    let mut id = String::new();
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch.to_ascii_lowercase());
        } else if !id.ends_with('-') {
            id.push('-');
        }
    }
    let id = id.trim_matches('-').to_owned();
    if id.is_empty() {
        "client".to_owned()
    } else {
        id
    }
}

pub fn clients_path(paths: &AppPaths) -> PathBuf {
    paths.state_dir.join("clients.json")
}

/// Load the saved clients. A machine that only ever used `remote connect`
/// before this file existed still has a `remote.json`; adopt it as the first
/// client so upgrading does not silently drop the connection.
pub fn load_clients(paths: &AppPaths) -> Result<ClientsFile> {
    let path = clients_path(paths);
    let mut file = match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str::<ClientsFile>(&contents)
            .with_context(|| format!("parse saved clients {}", path.display()))?,
        Err(err) if err.kind() == io::ErrorKind::NotFound => ClientsFile::default(),
        Err(err) => {
            return Err(err).with_context(|| format!("read saved clients {}", path.display()))
        }
    };
    file.clients
        .retain(|c| profile_is_usable(&c.address, &c.token));
    if file.active().is_none() {
        file.active_id = None;
    }
    if file.clients.is_empty() {
        if let Some(profile) = load_profile(paths)? {
            let id = file.upsert(None, &profile.address, &profile.token);
            file.active_id = Some(id);
        }
    }
    Ok(file)
}

/// Persist the list (owner-only: it holds every token) and mirror the active
/// client into `remote.json` so every existing reader follows the selection.
pub fn save_clients(paths: &AppPaths, file: &ClientsFile) -> Result<()> {
    std::fs::create_dir_all(&paths.state_dir)
        .with_context(|| format!("create archcar state dir {}", paths.state_dir.display()))?;
    let path = clients_path(paths);
    let body = serde_json::to_string_pretty(file)?;
    std::fs::write(&path, format!("{body}\n"))
        .with_context(|| format!("write saved clients {}", path.display()))?;
    restrict_to_owner(&path)?;
    match file.active() {
        Some(client) => save_profile(
            paths,
            &RemoteProfile {
                address: client.address.clone(),
                token: client.token.clone(),
            },
        ),
        None => clear_profile(paths).map(|_| ()),
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

    fn ssh(address: &str) -> SshTarget {
        parse_ssh_address(address)
            .expect("an ssh:// address")
            .expect("a valid ssh:// address")
    }

    #[test]
    fn an_ssh_address_parses_user_host_port_and_program() {
        assert_eq!(
            ssh("ssh://deploy@build.internal:2222/opt/archductor/bin/archductor"),
            SshTarget {
                destination: "deploy@build.internal".to_owned(),
                port: Some(2222),
                program: "/opt/archductor/bin/archductor".to_owned(),
            }
        );
        // Bare host: the program defaults, and `ssh` resolves the name through
        // ~/.ssh/config like any other destination.
        assert_eq!(
            ssh("ssh://devbox"),
            SshTarget {
                destination: "devbox".to_owned(),
                port: None,
                program: "archductor".to_owned(),
            }
        );
    }

    #[test]
    fn an_ipv6_literal_is_not_mistaken_for_a_port() {
        let target = ssh("ssh://[fe80::1]");

        assert_eq!(target.destination, "[fe80::1]");
        assert_eq!(target.port, None);
    }

    #[test]
    fn a_non_ssh_address_is_left_to_the_tcp_transport() {
        assert!(parse_ssh_address("devbox:7420").is_none());
        assert!(!is_ssh_address("devbox:7420"));
        assert!(is_ssh_address("  ssh://devbox  "));
    }

    #[test]
    fn a_broken_ssh_address_is_an_error_not_a_silent_fallback() {
        // Falling through to the TCP transport here would ask for a token the
        // user never intended to supply.
        assert!(parse_ssh_address("ssh://").unwrap().is_err());
        assert!(parse_ssh_address("ssh://host:notaport").unwrap().is_err());
    }

    #[test]
    fn ssh_args_disable_the_pty_and_prompts_and_end_with_the_proxy() {
        let args = ssh("ssh://deploy@host:2222").ssh_args();

        assert!(args.contains(&"-T".to_owned()), "{args:?}");
        // A password prompt would hang a client with no terminal.
        assert!(args.contains(&"BatchMode=yes".to_owned()), "{args:?}");
        assert!(
            args.contains(&"ServerAliveInterval=15".to_owned()),
            "{args:?}"
        );
        // Destination, then the program, then the proxy subcommand — in that
        // order, or ssh treats the arguments as part of the host expression.
        assert_eq!(
            args[args.len() - 5..],
            [
                "deploy@host".to_owned(),
                "archductor".to_owned(),
                "archcar".to_owned(),
                "stdio-proxy".to_owned(),
                "--quiet".to_owned(),
            ]
        );
        assert!(args.contains(&"2222".to_owned()), "{args:?}");
    }

    #[test]
    fn an_ssh_address_round_trips_through_the_saved_form() {
        for address in [
            "ssh://devbox",
            "ssh://deploy@build.internal:2222",
            "ssh://deploy@host/opt/bin/archductor",
        ] {
            assert_eq!(ssh(address).to_address(), address);
        }
    }

    #[test]
    fn the_ssh_failure_reason_skips_the_host_key_warning() {
        // ssh prints the known-hosts warning first, so reporting the first line
        // hides the reason the connection actually failed.
        let stderr = "Warning: Permanently added 'server' (ED25519) to the list of known hosts.\n\
                      arch@server: Permission denied (publickey).\n";

        assert_eq!(
            ssh_failure_reason(stderr),
            "arch@server: Permission denied (publickey)."
        );
    }

    #[test]
    fn the_ssh_failure_reason_falls_back_to_whatever_there_is() {
        assert_eq!(
            ssh_failure_reason("Warning: Permanently added 'x' (ED25519).\n"),
            "Warning: Permanently added 'x' (ED25519)."
        );
        assert_eq!(ssh_failure_reason("   \n  "), "");
    }

    #[test]
    fn an_ssh_profile_saves_and_loads_without_a_token() {
        // The TCP transport cannot work without a token, so a blank one used to
        // mean "half written". ssh:// has no token by design.
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());

        save_profile(
            &paths,
            &RemoteProfile {
                address: "ssh://deploy@host".to_owned(),
                token: String::new(),
            },
        )
        .unwrap();

        let loaded = load_profile(&paths).unwrap().unwrap();
        assert_eq!(loaded.address, "ssh://deploy@host");
        assert!(loaded.token.is_empty());
    }

    #[test]
    fn a_tcp_profile_still_requires_a_token() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());

        let err = save_profile(
            &paths,
            &RemoteProfile {
                address: "devbox:7420".to_owned(),
                token: String::new(),
            },
        )
        .unwrap_err();

        assert!(err.to_string().contains("token"), "{err}");
    }

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
    fn saving_clients_mirrors_the_active_one_into_the_remote_profile() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());

        let mut file = ClientsFile::default();
        let devbox = file.upsert(Some("Devbox"), "devbox:7420", "tok-a");
        let builder = file.upsert(Some("Builder"), "builder:7420", "tok-b");
        file.active_id = Some(builder.clone());
        save_clients(&paths, &file).unwrap();

        // Every existing reader goes through the profile, so it must follow.
        let profile = load_profile(&paths).unwrap().unwrap();
        assert_eq!(profile.address, "builder:7420");
        assert_eq!(profile.token, "tok-b");

        // Switching rewrites the mirror rather than accumulating state.
        let mut file = load_clients(&paths).unwrap();
        assert_eq!(file.clients.len(), 2);
        file.active_id = Some(devbox);
        save_clients(&paths, &file).unwrap();
        assert_eq!(
            load_profile(&paths).unwrap().unwrap().address,
            "devbox:7420"
        );

        // Selecting this machine clears the mirror entirely.
        file.active_id = None;
        save_clients(&paths, &file).unwrap();
        assert!(load_profile(&paths).unwrap().is_none());
        assert_eq!(load_clients(&paths).unwrap().clients.len(), 2);
    }

    #[test]
    fn reconnecting_to_a_known_address_refreshes_it_instead_of_duplicating() {
        let mut file = ClientsFile::default();
        let first = file.upsert(Some("Devbox"), "devbox:7420", "old");
        let again = file.upsert(None, "devbox:7420", "new");

        assert_eq!(first, again);
        assert_eq!(file.clients.len(), 1);
        assert_eq!(file.clients[0].token, "new");
        assert_eq!(
            file.clients[0].label, "Devbox",
            "an unnamed reconnect keeps the label"
        );
    }

    #[test]
    fn client_ids_are_slugs_and_stay_unique() {
        let mut file = ClientsFile::default();
        file.upsert(Some("My Devbox!"), "a:1", "t");
        file.upsert(Some("My Devbox!"), "b:2", "t");
        file.upsert(Some("   "), "c:3", "t");

        let ids: Vec<_> = file.clients.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["my-devbox", "my-devbox-2", "c-3"]);
        assert_eq!(
            file.clients[2].label, "c:3",
            "a blank label falls back to the address"
        );
    }

    #[test]
    fn clients_are_found_by_id_or_label_and_removal_clears_the_selection() {
        let mut file = ClientsFile::default();
        let id = file.upsert(Some("Devbox"), "devbox:7420", "tok");
        file.active_id = Some(id.clone());

        assert_eq!(
            file.find("devbox").map(|c| c.id.as_str()),
            Some(id.as_str())
        );
        assert_eq!(
            file.find("Devbox").map(|c| c.id.as_str()),
            Some(id.as_str())
        );
        assert_eq!(
            file.find("DEVBOX").map(|c| c.id.as_str()),
            Some(id.as_str())
        );
        assert!(file.find("nope").is_none());

        assert!(file.remove("Devbox"));
        assert!(file.clients.is_empty());
        assert_eq!(
            file.active_id, None,
            "removing the active client selects this machine"
        );
        assert!(!file.remove("Devbox"));
    }

    #[test]
    fn an_existing_single_profile_is_adopted_as_the_first_client() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());
        save_profile(
            &paths,
            &RemoteProfile {
                address: "devbox:7420".to_owned(),
                token: "tok".to_owned(),
            },
        )
        .unwrap();

        let file = load_clients(&paths).unwrap();

        assert_eq!(
            file.clients.len(),
            1,
            "upgrading must not drop the connection"
        );
        assert_eq!(
            file.active().map(|c| c.address.as_str()),
            Some("devbox:7420")
        );
        assert_eq!(file.clients[0].label, "devbox:7420");
    }

    #[test]
    fn an_active_id_with_no_matching_client_falls_back_to_this_machine() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());
        std::fs::create_dir_all(&paths.state_dir).unwrap();
        std::fs::write(
            clients_path(&paths),
            r#"{"active_id":"ghost","clients":[{"id":"devbox","label":"Devbox","address":"devbox:7420","token":"tok"}]}"#,
        )
        .unwrap();

        let file = load_clients(&paths).unwrap();

        assert_eq!(file.active_id, None);
        assert_eq!(file.clients.len(), 1);
    }

    #[test]
    fn clients_with_a_blank_address_or_token_are_dropped_on_load() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());
        std::fs::create_dir_all(&paths.state_dir).unwrap();
        std::fs::write(
            clients_path(&paths),
            r#"{"clients":[{"id":"a","label":"A","address":"","token":"t"},{"id":"b","label":"B","address":"b:1","token":"  "}]}"#,
        )
        .unwrap();

        assert!(load_clients(&paths).unwrap().clients.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn clients_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());
        let mut file = ClientsFile::default();
        file.upsert(Some("Devbox"), "devbox:7420", "tok");
        save_clients(&paths, &file).unwrap();

        let mode = std::fs::metadata(clients_path(&paths))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the file holds every client's token");
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
