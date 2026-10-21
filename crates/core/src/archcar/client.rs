use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tracing::{info, warn};
use uuid::Uuid;

use crate::archcar::protocol::{
    archcar_event_summary, archcar_request_summary, archcar_response_summary, ArchcarEvent,
    ArchcarRequest, ArchcarResponse, RpcEnvelope,
};
use crate::archcar::remote;
use crate::archcar::transport::{self, LocalStream};
use crate::paths::AppPaths;

/// A connection to archcar: the local endpoint on this machine, or a
/// token-authenticated TCP connection to a daemon somewhere else.
pub enum ArchcarStream {
    Local(LocalStream),
    Remote(std::net::TcpStream),
    /// An `ssh` child running the stdio proxy on the far side.
    Ssh(Box<remote::SshStream>),
}

impl ArchcarStream {
    fn set_read_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()> {
        match self {
            Self::Local(stream) => stream.set_read_timeout(timeout),
            Self::Remote(stream) => stream.set_read_timeout(timeout),
            // A pipe carries no timeout. ssh's ServerAliveInterval is what
            // notices a dead peer here; see `SshTarget::ssh_args`.
            Self::Ssh(_) => Ok(()),
        }
    }

    fn set_write_timeout(&self, timeout: Option<Duration>) -> std::io::Result<()> {
        match self {
            Self::Local(stream) => stream.set_write_timeout(timeout),
            Self::Remote(stream) => stream.set_write_timeout(timeout),
            Self::Ssh(_) => Ok(()),
        }
    }
}

impl std::io::Read for ArchcarStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Local(stream) => stream.read(buf),
            Self::Remote(stream) => stream.read(buf),
            Self::Ssh(stream) => stream.read(buf),
        }
    }
}

impl Write for ArchcarStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::Local(stream) => stream.write(buf),
            Self::Remote(stream) => stream.write(buf),
            Self::Ssh(stream) => stream.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::Local(stream) => stream.flush(),
            Self::Remote(stream) => stream.flush(),
            Self::Ssh(stream) => stream.flush(),
        }
    }
}

/// Where a client should look for archcar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchcarEndpoint {
    /// This machine's socket/pipe. The client may spawn a sidecar for it.
    Local(PathBuf),
    /// A daemon reachable over TCP, addressed as `host:port` with a token.
    Remote { address: String, token: String },
    /// A daemon reached by running the stdio proxy over SSH. No token: sshd has
    /// already authenticated the caller, and the far side talks to its own
    /// local socket, which filesystem permissions already guard.
    Ssh(remote::SshTarget),
}

impl ArchcarEndpoint {
    pub fn label(&self) -> String {
        match self {
            Self::Local(path) => path.display().to_string(),
            Self::Remote { address, .. } => format!("tcp://{address}"),
            Self::Ssh(target) => target.to_address(),
        }
    }

    /// Whether this endpoint is somebody else's process. A remote daemon must
    /// never be spawned locally, whichever transport reaches it.
    pub fn is_remote(&self) -> bool {
        !matches!(self, Self::Local(_))
    }
}

/// Bring up this machine's daemon if needed and hand back a raw connection to
/// it, bypassing any saved remote profile.
///
/// The ssh stdio proxy needs the byte stream rather than the request/response
/// API, and it needs the *local* daemon specifically: it runs on the server, and
/// the server may itself have a remote profile saved from when someone used it
/// as a client.
pub fn connect_local_daemon(paths: &AppPaths) -> Result<LocalStream> {
    let client = ArchcarClient::new(paths.archcar_endpoint_path());
    match client.connect_or_spawn()? {
        ArchcarStream::Local(stream) => Ok(stream),
        _ => anyhow::bail!("expected a local archcar connection"),
    }
}

/// Read `ARCHDUCTOR_ARCHCAR_REMOTE` (+ token) so any CLI/MCP process can be
/// pointed at another machine's daemon without code changes.
pub fn remote_endpoint_from_env(paths: &AppPaths) -> Result<Option<ArchcarEndpoint>> {
    let Some(address) = std::env::var(remote::REMOTE_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    if let Some(target) = remote::parse_ssh_address(&address) {
        return Ok(Some(ArchcarEndpoint::Ssh(target?)));
    }
    let token = match std::env::var(remote::TOKEN_ENV) {
        Ok(token) if !token.trim().is_empty() => token.trim().to_owned(),
        // A daemon on this machine shares its token file; a remote one needs
        // the token passed in.
        _ => remote::read_token(&remote::token_path(paths))?.with_context(|| {
            format!(
                "{} is set but no token was found; set {} or copy the daemon's token file",
                remote::REMOTE_ENV,
                remote::TOKEN_ENV
            )
        })?,
    };
    Ok(Some(ArchcarEndpoint::Remote { address, token }))
}

/// Where this process's archcar connection will go: the environment first,
/// then the persisted remote profile (`archductor remote connect`), then the
/// local daemon. This is the server-hosted execution switch — every CLI/MCP
/// client resolves through here.
pub fn configured_remote_endpoint(paths: &AppPaths) -> Result<Option<ArchcarEndpoint>> {
    if let Some(endpoint) = remote_endpoint_from_env(paths)? {
        return Ok(Some(endpoint));
    }
    let Some(profile) = remote::load_profile(paths)? else {
        return Ok(None);
    };
    if let Some(target) = remote::parse_ssh_address(&profile.address) {
        return Ok(Some(ArchcarEndpoint::Ssh(target?)));
    }
    Ok(Some(ArchcarEndpoint::Remote {
        address: profile.address,
        token: profile.token,
    }))
}

const ARCHCAR_HEALTHCHECK_TIMEOUT: Duration = Duration::from_millis(750);
const ARCHCAR_RPC_TIMEOUT: Duration = Duration::from_secs(30);
const ARCHCAR_STARTUP_ATTEMPTS: usize = 20;
const ARCHCAR_STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const ARCHCAR_VALIDATION_CACHE_TTL: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct ArchcarClient {
    endpoint: ArchcarEndpoint,
    endpoint_path: PathBuf,
    last_validated_at: Arc<Mutex<Option<Instant>>>,
}

impl ArchcarClient {
    /// Local daemon, unless `ARCHDUCTOR_ARCHCAR_REMOTE` or a saved remote
    /// profile points elsewhere.
    pub fn from_paths(paths: &AppPaths) -> Self {
        match configured_remote_endpoint(paths) {
            Ok(Some(endpoint)) => Self::with_endpoint(endpoint, paths.archcar_endpoint_path()),
            Ok(None) => Self::new(paths.archcar_endpoint_path()),
            Err(err) => {
                warn!(error = %err, "ignoring archcar remote configuration");
                Self::new(paths.archcar_endpoint_path())
            }
        }
    }

    /// This machine's daemon, ignoring any saved remote profile.
    ///
    /// A cross-daemon import needs both halves at once: the remote for reads and
    /// this one for the write. `from_paths` follows the profile, so it cannot be
    /// the local half while a remote is selected.
    pub fn local(paths: &AppPaths) -> Self {
        Self::new(paths.archcar_endpoint_path())
    }

    /// A saved client profile, by id or label, without switching to it.
    pub fn from_saved_client(profile: &remote::ClientProfile) -> Result<Self> {
        match remote::parse_ssh_address(&profile.address) {
            Some(target) => Ok(Self::ssh(target?)),
            None => Ok(Self::remote(profile.address.clone(), profile.token.clone())),
        }
    }

    pub fn remote(address: impl Into<String>, token: impl Into<String>) -> Self {
        let address = address.into();
        Self::with_endpoint(
            ArchcarEndpoint::Remote {
                address: address.clone(),
                token: token.into(),
            },
            PathBuf::from(format!("tcp://{address}")),
        )
    }

    /// A daemon reached over SSH. No token: sshd authenticates the caller.
    pub fn ssh(target: remote::SshTarget) -> Self {
        let endpoint_path = PathBuf::from(target.to_address());
        Self::with_endpoint(ArchcarEndpoint::Ssh(target), endpoint_path)
    }

    fn with_endpoint(endpoint: ArchcarEndpoint, endpoint_path: PathBuf) -> Self {
        Self {
            endpoint,
            endpoint_path,
            last_validated_at: Arc::new(Mutex::new(None)),
        }
    }

    pub fn endpoint(&self) -> &ArchcarEndpoint {
        &self.endpoint
    }

    fn new(endpoint_path: PathBuf) -> Self {
        Self {
            endpoint: ArchcarEndpoint::Local(endpoint_path.clone()),
            endpoint_path,
            last_validated_at: Arc::new(Mutex::new(None)),
        }
    }

    pub fn send(&self, request: ArchcarRequest) -> Result<ArchcarResponse> {
        let retryable = request_retry_safe_after_response_loss(&request);
        match self.send_once(request.clone()) {
            Ok(response) => Ok(response),
            Err(err) if retryable && response_decode_or_eof_error(&err) => {
                warn!(
                    endpoint = %self.endpoint_path.display(),
                    error = %err,
                    "archcar response decode failed; retrying idempotent request"
                );
                self.send_once(request)
            }
            Err(err) => Err(err),
        }
    }

    pub fn send_without_spawning(&self, request: ArchcarRequest) -> Result<ArchcarResponse> {
        let stream = self.connect_validated()?;
        self.send_on_stream(stream, request)
    }

    fn send_once(&self, request: ArchcarRequest) -> Result<ArchcarResponse> {
        let stream = self.connect_or_spawn()?;
        self.send_on_stream(stream, request)
    }

    fn send_on_stream(
        &self,
        mut stream: ArchcarStream,
        request: ArchcarRequest,
    ) -> Result<ArchcarResponse> {
        configure_rpc_timeouts(&stream, ARCHCAR_RPC_TIMEOUT)?;
        let request_summary = archcar_request_summary(&request);
        let envelope = RpcEnvelope {
            id: Uuid::new_v4().to_string(),
            payload: request,
        };
        let line = serde_json::to_string(&envelope)?;
        log_archcar_rpc(
            &self.endpoint_path,
            &envelope.id,
            "send",
            "request",
            request_summary,
            &line,
        );
        stream.write_all(line.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;

        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .context("read archcar sidecar response")?;
        anyhow::ensure!(
            !line.trim().is_empty(),
            "empty response from archcar sidecar"
        );
        let response: RpcEnvelope<ArchcarResponse> = serde_json::from_str(&line)?;
        log_archcar_rpc(
            &self.endpoint_path,
            &response.id,
            "recv",
            "response",
            archcar_response_summary(&response.payload),
            line.trim_end(),
        );
        Ok(response.payload)
    }

    pub fn subscribe(&self) -> Result<std::sync::mpsc::Receiver<ArchcarEvent>> {
        let mut stream = self.connect_or_spawn()?;
        configure_write_timeout(&stream, ARCHCAR_RPC_TIMEOUT)?;
        let envelope = RpcEnvelope {
            id: Uuid::new_v4().to_string(),
            payload: ArchcarRequest::Subscribe,
        };
        let line = serde_json::to_string(&envelope)?;
        log_archcar_rpc(
            &self.endpoint_path,
            &envelope.id,
            "send",
            "request",
            archcar_request_summary(&ArchcarRequest::Subscribe),
            &line,
        );
        stream.write_all(line.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        clear_rpc_timeouts(&stream)?;
        let (tx, rx) = std::sync::mpsc::channel();
        let endpoint_path = self.endpoint_path.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => match serde_json::from_str::<RpcEnvelope<ArchcarEvent>>(&line) {
                        Ok(event) => {
                            log_archcar_rpc(
                                &endpoint_path,
                                &event.id,
                                "recv",
                                "event",
                                archcar_event_summary(&event.payload),
                                line.trim_end(),
                            );
                            let _ = tx.send(event.payload);
                        }
                        Err(err) => {
                            warn!(
                                endpoint = %endpoint_path.display(),
                                error = %err,
                                bytes = line.len(),
                                "archcar local rpc event decode failed"
                            );
                        }
                    },
                    Err(_) => break,
                }
            }
        });
        Ok(rx)
    }

    fn connect_or_spawn(&self) -> Result<ArchcarStream> {
        // A remote daemon is somebody else's process; never try to spawn it.
        if self.endpoint.is_remote() {
            return self.connect_remote();
        }
        let first_err = match self.connect_checked() {
            Ok(stream) => return Ok(stream),
            // Something is listening there, maybe only too busy to answer in
            // time. Removing its socket file would orphan that daemon and cut
            // off every client of it, so surface the failure instead.
            Err(ConnectFailure::Unresponsive(err)) => return Err(err),
            Err(ConnectFailure::Dead(err)) => err,
        };
        warn!(
            endpoint = %self.endpoint_path.display(),
            error = %first_err,
            "archcar endpoint has no listener; spawning sidecar"
        );
        match remove_stale_endpoint(&self.endpoint_path) {
            Ok(()) => self.spawn_sidecar()?,
            // Another client's sidecar came up in the meantime; use it.
            Err(err) => warn!(
                endpoint = %self.endpoint_path.display(),
                error = %err,
                "archcar endpoint gained a listener; not spawning a sidecar"
            ),
        }
        for _ in 0..ARCHCAR_STARTUP_ATTEMPTS {
            match self.connect_validated() {
                Ok(stream) => return Ok(stream),
                Err(_) => thread::sleep(ARCHCAR_STARTUP_POLL_INTERVAL),
            }
        }
        Err(first_err).with_context(|| format!("connect archcar {}", self.endpoint_path.display()))
    }

    /// Open the transport for a non-local endpoint.
    fn connect_remote(&self) -> Result<ArchcarStream> {
        match &self.endpoint {
            ArchcarEndpoint::Remote { address, token } => {
                remote::connect(address, token).map(ArchcarStream::Remote)
            }
            ArchcarEndpoint::Ssh(target) => {
                remote::connect_ssh(target).map(|stream| ArchcarStream::Ssh(Box::new(stream)))
            }
            ArchcarEndpoint::Local(_) => unreachable!("caller checked is_remote"),
        }
    }

    fn connect_validated(&self) -> Result<ArchcarStream> {
        if self.endpoint.is_remote() {
            return self.connect_remote();
        }
        self.connect_checked().map_err(ConnectFailure::into_error)
    }

    /// Connect to the local endpoint and health-check it, telling apart an
    /// endpoint nobody listens on from a listener that would not answer.
    fn connect_checked(&self) -> std::result::Result<ArchcarStream, ConnectFailure> {
        let stream = self.connect_raw()?;
        if self.validation_cache_is_fresh() {
            return Ok(stream);
        }
        if let Err(err) = validate_sidecar_responsive(&self.endpoint_path, stream) {
            self.clear_validation_cache();
            return Err(ConnectFailure::Unresponsive(
                ArchcarEndpointUnresponsive {
                    endpoint: self.endpoint_path.clone(),
                    failure: format!(
                        "did not respond to a health check within {ARCHCAR_HEALTHCHECK_TIMEOUT:?}"
                    ),
                    source: err,
                }
                .into(),
            ));
        }
        self.mark_sidecar_validated();
        self.connect_raw()
    }

    fn connect_raw(&self) -> std::result::Result<ArchcarStream, ConnectFailure> {
        transport::connect(&self.endpoint_path)
            .map(ArchcarStream::Local)
            .map_err(|err| {
                self.clear_validation_cache();
                ConnectFailure::from_connect_error(&self.endpoint_path, err)
            })
    }

    fn spawn_sidecar(&self) -> Result<()> {
        let current_exe = std::env::current_exe().ok();
        let sibling = current_exe
            .as_ref()
            .map(|path| path.with_file_name("archcar"));
        let explicit = std::env::var_os("ARCHDUCTOR_ARCHCAR_BIN").map(PathBuf::from);
        let mut last_err = None;
        for (candidate, args) in explicit
            .into_iter()
            .map(|path| (path, Vec::<&str>::new()))
            .chain(
                current_exe
                    .clone()
                    .into_iter()
                    .map(|path| (path, vec!["--archcar-serve"])),
            )
            .chain(sibling.into_iter().map(|path| (path, Vec::<&str>::new())))
            .chain(std::iter::once((
                PathBuf::from("archcar"),
                Vec::<&str>::new(),
            )))
        {
            match Command::new(&candidate)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(_) => return Ok(()),
                Err(err) => last_err = Some((candidate, err)),
            }
        }
        let (candidate, err) = last_err.context("no archcar binary candidate available")?;
        Err(err).with_context(|| format!("spawn archcar binary {}", candidate.display()))
    }

    fn validation_cache_is_fresh(&self) -> bool {
        self.last_validated_at
            .lock()
            .ok()
            .and_then(|validated| *validated)
            .is_some_and(|validated| validated.elapsed() <= ARCHCAR_VALIDATION_CACHE_TTL)
    }

    fn mark_sidecar_validated(&self) {
        if let Ok(mut validated) = self.last_validated_at.lock() {
            *validated = Some(Instant::now());
        }
    }

    fn clear_validation_cache(&self) {
        if let Ok(mut validated) = self.last_validated_at.lock() {
            *validated = None;
        }
    }
}

fn validate_sidecar_responsive(endpoint_path: &Path, mut stream: ArchcarStream) -> Result<()> {
    configure_rpc_timeouts(&stream, ARCHCAR_HEALTHCHECK_TIMEOUT)?;
    let request = ArchcarRequest::ListProviderInteractions {
        thread_id: None,
        pending_only: true,
    };
    let envelope = RpcEnvelope {
        id: Uuid::new_v4().to_string(),
        payload: request,
    };
    let line = serde_json::to_string(&envelope)?;
    log_archcar_rpc(
        endpoint_path,
        &envelope.id,
        "send",
        "healthcheck",
        archcar_request_summary(&envelope.payload),
        &line,
    );
    stream.write_all(line.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .context("read archcar sidecar healthcheck response")?;
    anyhow::ensure!(
        !line.trim().is_empty(),
        "empty response from archcar sidecar healthcheck"
    );
    let response: RpcEnvelope<ArchcarResponse> = serde_json::from_str(&line)?;
    log_archcar_rpc(
        endpoint_path,
        &response.id,
        "recv",
        "healthcheck",
        archcar_response_summary(&response.payload),
        line.trim_end(),
    );
    Ok(())
}

fn configure_rpc_timeouts(stream: &ArchcarStream, timeout: Duration) -> Result<()> {
    stream
        .set_read_timeout(Some(timeout))
        .context("set archcar read timeout")?;
    configure_write_timeout(stream, timeout)
}

fn configure_write_timeout(stream: &ArchcarStream, timeout: Duration) -> Result<()> {
    stream
        .set_write_timeout(Some(timeout))
        .context("set archcar write timeout")?;
    Ok(())
}

fn clear_rpc_timeouts(stream: &ArchcarStream) -> Result<()> {
    stream
        .set_read_timeout(None)
        .context("clear archcar read timeout")?;
    stream
        .set_write_timeout(None)
        .context("clear archcar write timeout")?;
    Ok(())
}

/// Remove the socket file at `endpoint_path`, but only once a fresh connect
/// shows nobody listens on it (the same rule `transport::bind` applies).
/// Returns an error, leaving the file alone, if anything still answers there.
fn remove_stale_endpoint(endpoint_path: &Path) -> Result<()> {
    match transport::connect(endpoint_path) {
        Ok(_) => anyhow::bail!(
            "archcar endpoint {} has a live listener; refusing to remove its socket file",
            endpoint_path.display()
        ),
        Err(err) if endpoint_has_no_listener(&err) => {}
        Err(err) => {
            return Err(err).with_context(|| {
                format!(
                    "probe archcar endpoint {}; refusing to remove its socket file",
                    endpoint_path.display()
                )
            })
        }
    }
    match std::fs::remove_file(endpoint_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err)
            .with_context(|| format!("remove stale archcar endpoint {}", endpoint_path.display())),
    }
}

/// A connect error that proves nothing is listening at the endpoint, as
/// opposed to one a live but busy listener can cause (a full backlog is
/// `WouldBlock` on Linux).
fn endpoint_has_no_listener(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
    )
}

/// Why a local endpoint could not be used.
enum ConnectFailure {
    /// Nobody listens there: the socket file is stale and a sidecar may
    /// replace it.
    Dead(anyhow::Error),
    /// Something is, or may be, listening there: its socket file must not be
    /// touched.
    Unresponsive(anyhow::Error),
}

impl ConnectFailure {
    fn from_connect_error(endpoint: &Path, err: std::io::Error) -> Self {
        if endpoint_has_no_listener(&err) {
            return Self::Dead(err.into());
        }
        let failure = format!("did not accept the connection ({err})");
        Self::Unresponsive(
            ArchcarEndpointUnresponsive {
                endpoint: endpoint.to_path_buf(),
                failure,
                source: err.into(),
            }
            .into(),
        )
    }

    fn into_error(self) -> anyhow::Error {
        match self {
            Self::Dead(err) | Self::Unresponsive(err) => err,
        }
    }
}

/// The local endpoint has a listener that would not serve a request. The
/// client returns this rather than replacing the daemon, which may only be
/// overloaded; callers can downcast to it to tell it from "no daemon".
#[derive(Debug)]
pub struct ArchcarEndpointUnresponsive {
    endpoint: PathBuf,
    failure: String,
    source: anyhow::Error,
}

impl ArchcarEndpointUnresponsive {
    pub fn endpoint(&self) -> &Path {
        &self.endpoint
    }
}

impl std::fmt::Display for ArchcarEndpointUnresponsive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "archcar endpoint {} has a live listener that {}; refusing to touch its socket file (it may be overloaded) -- retry",
            self.endpoint.display(),
            self.failure
        )
    }
}

impl std::error::Error for ArchcarEndpointUnresponsive {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

fn response_decode_or_eof_error(err: &anyhow::Error) -> bool {
    err.to_string()
        .contains("empty response from archcar sidecar")
        || err.to_string().contains("read archcar sidecar response")
            && err
                .downcast_ref::<std::io::Error>()
                .is_some_and(|err| err.kind() == std::io::ErrorKind::TimedOut)
        || err
            .downcast_ref::<serde_json::Error>()
            .is_some_and(serde_json::Error::is_eof)
}

fn request_retry_safe_after_response_loss(request: &ArchcarRequest) -> bool {
    matches!(
        request,
        ArchcarRequest::GetSessionStatus { .. }
            | ArchcarRequest::GetSessionScreen { .. }
            | ArchcarRequest::GetSessionMessages { .. }
            | ArchcarRequest::GetChatSnapshot { .. }
            | ArchcarRequest::ResizeSession { .. }
            | ArchcarRequest::SetSessionModel { .. }
            | ArchcarRequest::SetSessionEffort { .. }
            | ArchcarRequest::SetSessionPermissionMode { .. }
    )
}

fn log_archcar_rpc(
    endpoint_path: &Path,
    rpc_id: &str,
    direction: &str,
    message_type: &str,
    summary: String,
    raw_payload: &str,
) {
    if let Some(payload) = archcar_rpc_log_payload(raw_payload) {
        info!(
            endpoint = %endpoint_path.display(),
            %rpc_id,
            direction,
            message_type,
            summary = %summary,
            payload = %payload,
            "archcar local rpc"
        );
    } else {
        info!(
            endpoint = %endpoint_path.display(),
            %rpc_id,
            direction,
            message_type,
            summary = %summary,
            "archcar local rpc"
        );
    }
}

fn archcar_rpc_log_payload(raw_payload: &str) -> Option<String> {
    archcar_rpc_log_payload_for_flag(
        raw_payload,
        crate::env_flags::enabled("ARCHDUCTOR_LOG_ARCHCAR_PAYLOADS"),
    )
}

fn archcar_rpc_log_payload_for_flag(raw_payload: &str, enabled: bool) -> Option<String> {
    enabled.then(|| crate::redaction::redact_sensitive_text(raw_payload))
}

#[cfg(test)]
mod tests {
    use super::{
        archcar_rpc_log_payload_for_flag, request_retry_safe_after_response_loss,
        response_decode_or_eof_error,
    };
    use crate::archcar::protocol::{
        ArchcarInputDelivery, ArchcarInputKind, ArchcarRequest, RpcEnvelope,
    };
    use std::io::{BufRead, BufReader, Write};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    };
    use std::time::Duration;

    #[test]
    fn client_rpc_log_payload_redacts_sensitive_values_when_payload_logging_is_enabled() {
        let envelope = RpcEnvelope {
            id: "abc".to_owned(),
            payload: ArchcarRequest::SendInput {
                session_id: 42,
                input: "OPENAI_API_KEY=sk-secret bearer ghp_secret --password swordfish".to_owned(),
                visible_input: None,
                kind: ArchcarInputKind::User,
                delivery: ArchcarInputDelivery::Auto,
            },
        };
        let line = serde_json::to_string(&envelope).unwrap();

        let payload = archcar_rpc_log_payload_for_flag(&line, true).unwrap();

        assert!(payload.contains("[redacted]"));
        assert!(!payload.contains("sk-secret"));
        assert!(!payload.contains("ghp_secret"));
        assert!(!payload.contains("swordfish"));
    }

    #[cfg(unix)]
    #[test]
    fn client_returns_when_endpoint_accepts_but_never_answers() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-stopped.sock");
        let listener = crate::archcar::transport::bind(&endpoint).unwrap();
        let (accepted_tx, accepted_rx) = mpsc::channel();
        let server_endpoint = endpoint.clone();
        let _server = std::thread::spawn(move || {
            let (stream, _) =
                crate::archcar::transport::accept(&listener, &server_endpoint).unwrap();
            accepted_tx.send(()).unwrap();
            let _stream = stream;
            std::thread::sleep(Duration::from_secs(10));
        });

        let _env_guard = archcar_bin_env_lock().lock().unwrap();
        let previous_archcar_bin = std::env::var_os("ARCHDUCTOR_ARCHCAR_BIN");
        std::env::set_var("ARCHDUCTOR_ARCHCAR_BIN", "/bin/false");
        let client = super::ArchcarClient::new(endpoint);
        let (tx, rx) = mpsc::channel();
        let _client_thread = std::thread::spawn(move || {
            let result = client.send(ArchcarRequest::GetSessionMessages { thread_id: 1 });
            let _ = tx.send(result);
        });

        accepted_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("client did not connect to test endpoint");
        let result = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("client hung on an unresponsive archcar endpoint");
        assert!(result.is_err());

        if let Some(value) = previous_archcar_bin {
            std::env::set_var("ARCHDUCTOR_ARCHCAR_BIN", value);
        } else {
            std::env::remove_var("ARCHDUCTOR_ARCHCAR_BIN");
        }
    }

    fn archcar_bin_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[cfg(unix)]
    #[test]
    fn client_reuses_recent_sidecar_validation() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-responsive.sock");
        let listener = crate::archcar::transport::bind(&endpoint).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let healthchecks = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let server_endpoint = endpoint.clone();
        let server_stop = stop.clone();
        let server_healthchecks = healthchecks.clone();
        let server_requests = requests.clone();
        let server = std::thread::spawn(move || {
            while !server_stop.load(Ordering::SeqCst) {
                let (mut stream, _) =
                    match crate::archcar::transport::accept(&listener, &server_endpoint) {
                        Ok(stream) => stream,
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(10));
                            continue;
                        }
                        Err(err) => panic!("accept archcar test connection: {err}"),
                    };
                let mut line = String::new();
                {
                    let mut reader = BufReader::new(&mut stream);
                    reader.read_line(&mut line).unwrap();
                }
                let request: RpcEnvelope<ArchcarRequest> = serde_json::from_str(&line).unwrap();
                let response = match request.payload {
                    ArchcarRequest::ListProviderInteractions { .. } => {
                        server_healthchecks.fetch_add(1, Ordering::SeqCst);
                        super::ArchcarResponse::ProviderInteractions {
                            interactions: Vec::new(),
                        }
                    }
                    ArchcarRequest::GetSessionMessages { thread_id } => {
                        server_requests.fetch_add(1, Ordering::SeqCst);
                        super::ArchcarResponse::SessionMessages {
                            thread_id,
                            messages: Vec::new(),
                        }
                    }
                    other => panic!("unexpected archcar test request: {other:?}"),
                };
                let response = RpcEnvelope {
                    id: request.id,
                    payload: response,
                };
                let line = serde_json::to_string(&response).unwrap();
                stream.write_all(line.as_bytes()).unwrap();
                stream.write_all(b"\n").unwrap();
                stream.flush().unwrap();
            }
        });

        let client = super::ArchcarClient::new(endpoint);

        client
            .send(ArchcarRequest::GetSessionMessages { thread_id: 1 })
            .unwrap();
        client
            .send(ArchcarRequest::GetSessionMessages { thread_id: 1 })
            .unwrap();
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();

        assert_eq!(requests.load(Ordering::SeqCst), 2);
        assert_eq!(healthchecks.load(Ordering::SeqCst), 1);
    }

    /// Points the sidecar spawn fallback at a binary that exits at once, so a
    /// client test can never launch a real daemon, and restores it on drop.
    struct ArchcarBinGuard {
        previous: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl ArchcarBinGuard {
        fn bin_false() -> Self {
            let lock = archcar_bin_env_lock()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous = std::env::var_os("ARCHDUCTOR_ARCHCAR_BIN");
            std::env::set_var("ARCHDUCTOR_ARCHCAR_BIN", "/bin/false");
            Self {
                previous,
                _lock: lock,
            }
        }
    }

    impl Drop for ArchcarBinGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("ARCHDUCTOR_ARCHCAR_BIN", value),
                None => std::env::remove_var("ARCHDUCTOR_ARCHCAR_BIN"),
            }
        }
    }

    /// A daemon that answers every request at once except the first health
    /// check, whose answer it holds until the test sends on the returned
    /// channel: alive, but too busy for that one RPC.
    #[cfg(unix)]
    fn spawn_daemon_holding_first_healthcheck(
        endpoint: &std::path::Path,
    ) -> (
        mpsc::Sender<()>,
        mpsc::Receiver<()>,
        Arc<AtomicBool>,
        std::thread::JoinHandle<()>,
    ) {
        let listener = crate::archcar::transport::bind(endpoint).unwrap();
        listener.set_nonblocking(true).unwrap();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Arc::new(Mutex::new(Some(release_rx)));
        let (held_tx, held_rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = stop.clone();
        let server_endpoint = endpoint.to_path_buf();
        let server = std::thread::spawn(move || {
            let mut handlers = Vec::new();
            while !server_stop.load(Ordering::SeqCst) {
                let (mut stream, _) =
                    match crate::archcar::transport::accept(&listener, &server_endpoint) {
                        Ok(stream) => stream,
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(10));
                            continue;
                        }
                        Err(err) => panic!("accept archcar test connection: {err}"),
                    };
                let release_rx = release_rx.clone();
                let held_tx = held_tx.clone();
                handlers.push(std::thread::spawn(move || {
                    let mut line = String::new();
                    {
                        let mut reader = BufReader::new(&mut stream);
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                    }
                    let request: RpcEnvelope<ArchcarRequest> = serde_json::from_str(&line).unwrap();
                    let response = match request.payload {
                        ArchcarRequest::ListProviderInteractions { .. } => {
                            let held = release_rx.lock().unwrap().take();
                            if let Some(release) = held {
                                held_tx.send(()).unwrap();
                                let _ = release.recv_timeout(Duration::from_secs(30));
                            }
                            super::ArchcarResponse::ProviderInteractions {
                                interactions: Vec::new(),
                            }
                        }
                        ArchcarRequest::GetSessionMessages { thread_id } => {
                            super::ArchcarResponse::SessionMessages {
                                thread_id,
                                messages: Vec::new(),
                            }
                        }
                        other => panic!("unexpected archcar test request: {other:?}"),
                    };
                    let line = serde_json::to_string(&RpcEnvelope {
                        id: request.id,
                        payload: response,
                    })
                    .unwrap();
                    // The client may have given up on this answer already.
                    let _ = stream.write_all(format!("{line}\n").as_bytes());
                }));
            }
            for handler in handlers {
                handler.join().unwrap();
            }
        });
        (release_tx, held_rx, stop, server)
    }

    #[cfg(unix)]
    #[test]
    fn client_keeps_the_socket_of_a_live_daemon_whose_healthcheck_times_out() {
        let _bin = ArchcarBinGuard::bin_false();
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar.sock");
        let (release, held, stop, server) = spawn_daemon_holding_first_healthcheck(&endpoint);

        let err = super::ArchcarClient::new(endpoint.clone())
            .send(ArchcarRequest::GetSessionMessages { thread_id: 1 })
            .expect_err("a health check the daemon has not answered cannot pass");
        held.try_recv()
            .expect("the client should have reached the daemon's health check");

        assert!(
            endpoint.exists(),
            "the client removed the socket file of a live daemon: {err:#}"
        );
        assert!(
            std::os::unix::net::UnixStream::connect(&endpoint).is_ok(),
            "the live daemon no longer accepts at {}",
            endpoint.display()
        );
        let answer = super::ArchcarClient::new(endpoint.clone())
            .send_without_spawning(ArchcarRequest::GetSessionMessages { thread_id: 7 })
            .expect("the live daemon should still answer requests");
        assert!(matches!(
            answer,
            super::ArchcarResponse::SessionMessages { thread_id: 7, .. }
        ));
        let message = err.to_string();
        assert!(
            message.contains("has a live listener that did not respond to a health check")
                && message.contains("refusing to touch its socket file"),
            "expected the unresponsive-listener error, got: {err:#}"
        );

        release.send(()).unwrap();
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn client_reports_an_unresponsive_listener_as_its_own_error() {
        let _bin = ArchcarBinGuard::bin_false();
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar.sock");
        let (release, _held, stop, server) = spawn_daemon_holding_first_healthcheck(&endpoint);

        let err = super::ArchcarClient::new(endpoint.clone())
            .send(ArchcarRequest::GetSessionMessages { thread_id: 1 })
            .unwrap_err();
        let unresponsive = err
            .downcast_ref::<super::ArchcarEndpointUnresponsive>()
            .expect("expected ArchcarEndpointUnresponsive");
        assert_eq!(unresponsive.endpoint(), endpoint.as_path());

        release.send(()).unwrap();
        stop.store(true, Ordering::SeqCst);
        server.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn client_replaces_a_socket_file_nobody_listens_on() {
        let _bin = ArchcarBinGuard::bin_false();
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar.sock");
        // Binding and dropping leaves the file behind with no listener.
        drop(crate::archcar::transport::bind(&endpoint).unwrap());
        assert!(endpoint.exists());

        let err = super::ArchcarClient::new(endpoint.clone())
            .send(ArchcarRequest::GetSessionMessages { thread_id: 1 })
            .expect_err("the spawn fallback is /bin/false, so no daemon comes up");

        assert!(
            !endpoint.exists(),
            "the stale socket file should have been removed"
        );
        assert!(err
            .downcast_ref::<super::ArchcarEndpointUnresponsive>()
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn remove_stale_endpoint_refuses_a_socket_with_a_live_listener() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar.sock");
        let _listener = crate::archcar::transport::bind(&endpoint).unwrap();

        let err = super::remove_stale_endpoint(&endpoint).unwrap_err();

        assert!(err.to_string().contains("has a live listener"), "{err:#}");
        assert!(endpoint.exists());
        assert!(std::os::unix::net::UnixStream::connect(&endpoint).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn remove_stale_endpoint_removes_a_dead_or_missing_socket() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar.sock");
        drop(crate::archcar::transport::bind(&endpoint).unwrap());

        super::remove_stale_endpoint(&endpoint).unwrap();
        assert!(!endpoint.exists());
        super::remove_stale_endpoint(&endpoint).unwrap();
    }

    #[test]
    fn response_loss_retry_is_limited_to_idempotent_requests() {
        assert!(request_retry_safe_after_response_loss(
            &ArchcarRequest::GetSessionStatus { session_id: 42 }
        ));
        assert!(request_retry_safe_after_response_loss(
            &ArchcarRequest::ResizeSession {
                session_id: 42,
                rows: 24,
                cols: 80,
            }
        ));
        assert!(request_retry_safe_after_response_loss(
            &ArchcarRequest::SetSessionModel {
                session_id: 42,
                model: Some("gpt-5".to_owned()),
            }
        ));
        assert!(request_retry_safe_after_response_loss(
            &ArchcarRequest::SetSessionEffort {
                session_id: 42,
                effort: Some("high".to_owned()),
            }
        ));
        assert!(request_retry_safe_after_response_loss(
            &ArchcarRequest::SetSessionPermissionMode {
                session_id: 42,
                mode: "default".to_owned(),
            }
        ));
        assert!(!request_retry_safe_after_response_loss(
            &ArchcarRequest::SendInput {
                session_id: 42,
                input: "hello".to_owned(),
                visible_input: None,
                kind: ArchcarInputKind::User,
                delivery: ArchcarInputDelivery::Auto,
            }
        ));
        assert!(!request_retry_safe_after_response_loss(
            &ArchcarRequest::SpawnSession {
                workspace: "berlin".to_owned(),
                kind: crate::workspace::SessionKind::CODEX,
                harness: None,
            }
        ));
    }

    #[test]
    fn response_loss_detects_any_json_eof_decode_error() {
        let err: anyhow::Error = serde_json::from_str::<serde_json::Value>(r#"{"payload":["#)
            .unwrap_err()
            .into();

        assert!(response_decode_or_eof_error(&err));
    }
}
