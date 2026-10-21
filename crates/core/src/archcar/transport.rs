use std::io;
#[cfg(windows)]
use std::io::{Read, Write};
use std::path::Path;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
pub type LocalListener = std::net::TcpListener;
#[cfg(windows)]
pub type LocalStream = std::net::TcpStream;

#[cfg(unix)]
pub type LocalListener = std::os::unix::net::UnixListener;
#[cfg(unix)]
pub type LocalStream = std::os::unix::net::UnixStream;

/// A connection archcar can serve RPCs over: the local endpoint, or a TCP
/// stream from the token-guarded remote listener.
pub trait DuplexStream: io::Read + io::Write + Send + Sized + 'static {
    fn try_clone_stream(&self) -> io::Result<Self>;
    fn set_stream_timeouts(&self, timeout: Option<std::time::Duration>) -> io::Result<()>;
}

impl DuplexStream for std::net::TcpStream {
    fn try_clone_stream(&self) -> io::Result<Self> {
        self.try_clone()
    }

    fn set_stream_timeouts(&self, timeout: Option<std::time::Duration>) -> io::Result<()> {
        self.set_read_timeout(timeout)?;
        self.set_write_timeout(timeout)
    }
}

#[cfg(unix)]
impl DuplexStream for std::os::unix::net::UnixStream {
    fn try_clone_stream(&self) -> io::Result<Self> {
        self.try_clone()
    }

    fn set_stream_timeouts(&self, timeout: Option<std::time::Duration>) -> io::Result<()> {
        self.set_read_timeout(timeout)?;
        self.set_write_timeout(timeout)
    }
}

#[cfg(unix)]
pub fn bind(endpoint: &Path) -> io::Result<LocalListener> {
    if endpoint.exists() {
        match LocalStream::connect(endpoint) {
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "archcar endpoint already has a live listener",
                ));
            }
            Err(err) if err.kind() == io::ErrorKind::ConnectionRefused => {
                std::fs::remove_file(endpoint)?;
            }
            Err(_) => {
                std::fs::remove_file(endpoint)?;
            }
        }
    }
    LocalListener::bind(endpoint)
}

#[cfg(unix)]
pub fn accept(listener: &LocalListener, _endpoint: &Path) -> io::Result<(LocalStream, ())> {
    let (stream, _) = listener.accept()?;
    stream.set_nonblocking(false)?;
    Ok((stream, ()))
}

#[cfg(unix)]
pub fn connect(endpoint: &Path) -> io::Result<LocalStream> {
    LocalStream::connect(endpoint)
}

/// Block until `listener` has a connection waiting, or `timeout` elapses.
///
/// The accept loops run their listeners non-blocking so they can notice the
/// shutdown flag, but a non-blocking accept paired with a sleep charges every
/// client that sleep as latency: at a 50ms tick a `ping` round-tripped in
/// ~52ms, and the desktop app opens a fresh connection per RPC. Waiting on
/// readiness instead makes the accept immediate while keeping the timeout that
/// lets the loop re-check shutdown.
///
/// Returns `true` when a connection is ready, `false` when the timeout expired.
#[cfg(unix)]
pub fn wait_for_connection<F: std::os::fd::AsFd>(
    listener: &F,
    timeout: std::time::Duration,
) -> io::Result<bool> {
    use rustix::event::{PollFd, PollFlags};

    let deadline = rustix::fs::Timespec {
        tv_sec: timeout.as_secs() as _,
        tv_nsec: timeout.subsec_nanos() as _,
    };
    let mut fds = [PollFd::new(listener, PollFlags::IN)];
    match rustix::event::poll(&mut fds, Some(&deadline)) {
        Ok(0) => Ok(false),
        Ok(_) => Ok(true),
        // A signal (the ctrl-c handler installs one) interrupts the wait; that
        // is not an error, the caller just re-checks shutdown and waits again.
        Err(rustix::io::Errno::INTR) => Ok(false),
        Err(err) => Err(io::Error::from(err)),
    }
}

/// Windows listens on a loopback `TcpListener` rather than a unix socket, and
/// `rustix` is a unix-only dependency here, so that build keeps the sleep tick.
#[cfg(windows)]
pub fn wait_for_connection<F>(_listener: &F, timeout: std::time::Duration) -> io::Result<bool> {
    std::thread::sleep(timeout);
    Ok(true)
}

#[cfg(windows)]
fn singleton_lock_path(endpoint: &Path) -> std::path::PathBuf {
    endpoint.with_extension("endpoint.lock")
}

/// Opens (creating if needed) the lock file for `endpoint` with share mode 0:
/// no other handle may open this path at all while it is held, so whichever
/// process wins this open owns the endpoint. Windows closes the handle when
/// the process exits for any reason, including a crash, so a dead daemon
/// never wedges later starts.
#[cfg(windows)]
fn acquire_singleton_lock(endpoint: &Path) -> io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .share_mode(0)
        .open(singleton_lock_path(endpoint))
}

/// Windows has no socket file to probe, so ownership of the endpoint is an
/// exclusive lock file held for the life of the daemon: a second daemon fails
/// with `AddrInUse`, as on Unix. Probing the recorded TCP address instead was
/// rejected because the OS can recycle a dead daemon's port to an unrelated
/// process, which would read as a live listener and wedge every later start.
///
/// The one exception is an endpoint with no lock file beside it, which a
/// daemon built before the lock may still be serving. Only there does `bind`
/// probe, and it counts the daemon live only if it completes the token
/// handshake and answers an RPC (`pre_lock_daemon_answers`), which a recycled
/// port cannot do.
#[cfg(windows)]
pub fn bind(endpoint: &Path) -> io::Result<LocalListener> {
    // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION: another process holds it.
    const SHARING_VIOLATION: i32 = 32;
    const LOCK_VIOLATION: i32 = 33;
    let lock_path = singleton_lock_path(endpoint);
    let lock_existed = lock_path.exists();
    let lock = match acquire_singleton_lock(endpoint) {
        Ok(lock) => lock,
        Err(err) if matches!(err.raw_os_error(), Some(SHARING_VIOLATION | LOCK_VIOLATION)) => {
            return Err(live_listener_error());
        }
        Err(err) => return Err(err),
    };
    if !lock_existed && endpoint.exists() && pre_lock_daemon_answers(endpoint) {
        // Leave no lock file behind: the next start must probe this daemon
        // again, not trust a lock nobody holds.
        release_singleton_lock(lock, &lock_path);
        return Err(live_listener_error());
    }
    match publish_endpoint(endpoint) {
        Ok(listener) => {
            // Held until this process exits, crash included; the OS release
            // is what lets the next daemon in. Only now, once this process
            // really serves the endpoint: forgetting it on a failed bind
            // would refuse every later bind here for the life of the process.
            std::mem::forget(lock);
            Ok(listener)
        }
        Err(err) => {
            release_singleton_lock(lock, &lock_path);
            Err(err)
        }
    }
}

/// Bind the loopback listener and publish its address and token at `endpoint`.
#[cfg(windows)]
fn publish_endpoint(endpoint: &Path) -> io::Result<LocalListener> {
    let listener = LocalListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let address = listener.local_addr()?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let temporary = endpoint.with_extension("endpoint.tmp");
    std::fs::write(&temporary, format!("{address}\n{token}\n"))?;
    if endpoint.exists() {
        std::fs::remove_file(endpoint)?;
    }
    std::fs::rename(temporary, endpoint)?;
    Ok(listener)
}

/// Give the lock up on a path where this process does not become the
/// endpoint's daemon, removing the file so no later start trusts a lock nobody
/// holds. Best effort: another start may already have it open again.
#[cfg(windows)]
fn release_singleton_lock(lock: std::fs::File, lock_path: &Path) {
    drop(lock);
    let _ = std::fs::remove_file(lock_path);
}

#[cfg(windows)]
fn live_listener_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::AddrInUse,
        "archcar endpoint already has a live listener",
    )
}

/// The whole pre-lock probe, connect through reply, must finish inside this,
/// so a listener that never answers, or trickles bytes, cannot hold up startup
/// while `bind` holds the singleton lock.
#[cfg(windows)]
const PRE_LOCK_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// The most reply bytes the probe reads. It needs only the envelope's opening
/// `{"id":"<uuid>","payload":`, not the whole line: a daemon's reply can run
/// far longer, and a peer that never sends a newline must not grow a buffer.
#[cfg(windows)]
const PRE_LOCK_PROBE_REPLY_LIMIT: usize = 256;

/// Whether a daemon still serves `endpoint`: it accepts the recorded token and
/// answers an RPC with the same envelope id. A successful `connect` alone
/// proves nothing, since writing the token succeeds against any listener and
/// the server drops a connection with a wrong token without a word. Any
/// failure, including running out of time, reads as not live.
#[cfg(windows)]
fn pre_lock_daemon_answers(endpoint: &Path) -> bool {
    let deadline = std::time::Instant::now() + PRE_LOCK_PROBE_TIMEOUT;
    probe_pre_lock_daemon(endpoint, deadline).unwrap_or(false)
}

#[cfg(windows)]
fn probe_pre_lock_daemon(endpoint: &Path, deadline: std::time::Instant) -> io::Result<bool> {
    use crate::archcar::protocol::{ArchcarRequest, RpcEnvelope};

    let contents = std::fs::read_to_string(endpoint)?;
    let mut lines = contents.lines();
    let (Some(address), Some(token)) = (lines.next(), lines.next()) else {
        return Ok(false);
    };
    let Ok(address) = address.trim().parse::<std::net::SocketAddr>() else {
        return Ok(false);
    };
    let mut stream = LocalStream::connect_timeout(&address, time_left(deadline)?)?;
    // A read-only request every daemon build with Windows support answers.
    let request = RpcEnvelope {
        id: uuid::Uuid::new_v4().to_string(),
        payload: ArchcarRequest::ListLayoutPresets,
    };
    let line = serde_json::to_string(&request).map_err(io::Error::other)?;
    stream.set_write_timeout(Some(time_left(deadline)?))?;
    stream.write_all(format!("{}\n{line}\n", token.trim_end()).as_bytes())?;
    stream.flush()?;
    // `RpcEnvelope` serializes `id` first, in every build, so a daemon's reply
    // opens with exactly this.
    let id = serde_json::to_string(&request.id).map_err(io::Error::other)?;
    let expected = format!("{{\"id\":{id},\"payload\":");
    if expected.len() > PRE_LOCK_PROBE_REPLY_LIMIT {
        return Ok(false);
    }
    let mut reply = vec![0_u8; expected.len()];
    let mut filled = 0;
    while filled < reply.len() {
        stream.set_read_timeout(Some(time_left(deadline)?))?;
        match stream.read(&mut reply[filled..])? {
            0 => return Ok(false),
            read => filled += read,
        }
    }
    Ok(reply == expected.as_bytes())
}

/// Time left before `deadline`, or `TimedOut` once it has passed. Never zero,
/// which the socket timeout setters reject.
#[cfg(windows)]
fn time_left(deadline: std::time::Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(std::time::Instant::now())
        .filter(|left| !left.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "pre-lock probe ran out of time"))
}

#[cfg(windows)]
pub fn accept(listener: &LocalListener, endpoint: &Path) -> io::Result<(LocalStream, ())> {
    let expected = endpoint_token(endpoint)?;
    loop {
        let (mut stream, _) = listener.accept()?;
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        let mut token = Vec::new();
        let mut byte = [0_u8; 1];
        while stream.read_exact(&mut byte).is_ok() {
            if byte[0] == b'\n' {
                break;
            }
            token.push(byte[0]);
        }
        if String::from_utf8_lossy(&token).trim_end_matches('\r') == expected {
            stream.set_read_timeout(None)?;
            return Ok((stream, ()));
        }
    }
}

#[cfg(windows)]
pub fn connect(endpoint: &Path) -> io::Result<LocalStream> {
    let contents = std::fs::read_to_string(endpoint)?;
    let mut lines = contents.lines();
    let address = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing archcar address"))?;
    let token = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing archcar token"))?;
    let mut stream = LocalStream::connect(address.trim())?;
    stream.write_all(token.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;
    Ok(stream)
}

#[cfg(windows)]
fn endpoint_token(endpoint: &Path) -> io::Result<String> {
    std::fs::read_to_string(endpoint)?
        .lines()
        .nth(1)
        .map(str::to_owned)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing archcar token"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::time::Duration;

    #[test]
    fn local_transport_round_trips() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-test.endpoint");
        let listener = bind(&endpoint).unwrap();
        let server_endpoint = endpoint.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = accept(&listener, &server_endpoint).unwrap();
            let mut bytes = [0_u8; 4];
            stream.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, b"ping");
            stream.write_all(b"pong").unwrap();
        });

        let mut client = connect(&endpoint).unwrap();
        client.write_all(b"ping").unwrap();
        let mut bytes = [0_u8; 4];
        client.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"pong");
        server.join().unwrap();
    }

    #[test]
    fn accepted_stream_from_nonblocking_listener_writes_large_response() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-large-response.endpoint");
        let listener = bind(&endpoint).unwrap();
        listener.set_nonblocking(true).unwrap();
        let server_endpoint = endpoint.clone();
        let payload = vec![b'x'; 256 * 1024];
        let expected_len = payload.len();
        let server = std::thread::spawn(move || -> io::Result<()> {
            let (mut stream, _) = loop {
                match accept(&listener, &server_endpoint) {
                    Ok(accepted) => break accepted,
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(err) => return Err(err),
                }
            };
            stream.write_all(&payload)?;
            stream.write_all(b"\n")?;
            stream.flush()
        });

        let mut client = connect(&endpoint).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        let mut received = Vec::new();
        client.read_to_end(&mut received).unwrap();

        server.join().unwrap().unwrap();
        assert_eq!(received.len(), expected_len + 1);
        assert_eq!(received.last(), Some(&b'\n'));
    }

    #[cfg(unix)]
    #[test]
    fn wait_for_connection_reports_a_waiting_client() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-wait-ready.endpoint");
        let listener = bind(&endpoint).unwrap();
        listener.set_nonblocking(true).unwrap();

        let _client = connect(&endpoint).unwrap();

        assert!(wait_for_connection(&listener, Duration::from_secs(5)).unwrap());
        // Readiness must not consume the connection.
        assert!(accept(&listener, &endpoint).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn wait_for_connection_wakes_on_a_late_client_rather_than_sleeping_out_the_timeout() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-wait-late.endpoint");
        let listener = bind(&endpoint).unwrap();
        listener.set_nonblocking(true).unwrap();

        let client_endpoint = endpoint.clone();
        let client = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            connect(&client_endpoint).unwrap()
        });

        let started = std::time::Instant::now();
        let ready = wait_for_connection(&listener, Duration::from_secs(10)).unwrap();
        let waited = started.elapsed();
        let _client = client.join().unwrap();

        assert!(ready);
        // The client connected after ~50ms; returning near the 10s timeout
        // would mean the wait ignored readiness.
        assert!(waited < Duration::from_secs(1), "waited {waited:?}");
    }

    #[cfg(unix)]
    #[test]
    fn wait_for_connection_times_out_with_no_client() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-wait-idle.endpoint");
        let listener = bind(&endpoint).unwrap();
        listener.set_nonblocking(true).unwrap();

        let started = std::time::Instant::now();
        assert!(!wait_for_connection(&listener, Duration::from_millis(100)).unwrap());
        assert!(started.elapsed() >= Duration::from_millis(90));
    }

    #[cfg(unix)]
    #[test]
    fn bind_refuses_live_unix_endpoint() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-live.endpoint");
        let _listener = bind(&endpoint).unwrap();

        let err = bind(&endpoint).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
    }

    #[cfg(windows)]
    #[test]
    fn bind_refuses_live_windows_endpoint() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-live.endpoint");
        let _listener = bind(&endpoint).unwrap();

        let err = bind(&endpoint).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
    }

    #[cfg(windows)]
    #[test]
    fn bind_reclaims_a_stale_windows_lock() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-stale.endpoint");
        {
            // A prior daemon held the lock and left its endpoint file behind;
            // dropping the handle is what the OS does when that process exits
            // or crashes.
            let _lock = acquire_singleton_lock(&endpoint).unwrap();
            std::fs::write(&endpoint, "127.0.0.1:1\nstaletoken\n").unwrap();
        }

        assert!(bind(&endpoint).is_ok());
    }

    /// Stands in for a daemon built before the singleton lock: it records its
    /// endpoint the way that build did, holds no lock file, and serves one
    /// connection through the real token handshake (`accept`) and RPC framing.
    /// The returned handle yields whether it answered a request.
    #[cfg(windows)]
    fn spawn_pre_lock_daemon(endpoint: &Path) -> std::thread::JoinHandle<bool> {
        use crate::archcar::protocol::{ArchcarRequest, ArchcarResponse, RpcEnvelope};
        use std::io::BufRead;

        let listener = LocalListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        std::fs::write(endpoint, format!("{address}\nprelocktoken\n")).unwrap();
        let endpoint = endpoint.to_path_buf();
        std::thread::spawn(move || {
            let (stream, _) = accept(&listener, &endpoint).unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut line = String::new();
            io::BufReader::new(stream).read_line(&mut line).unwrap();
            let Ok(request) = serde_json::from_str::<RpcEnvelope<ArchcarRequest>>(&line) else {
                return false;
            };
            // A reply line far longer than the probe reads, as a daemon with
            // many saved layout presets sends; the probe must still see it.
            let reply = RpcEnvelope {
                id: request.id,
                payload: ArchcarResponse::Error {
                    message: "x".repeat(4096),
                },
            };
            writeln!(writer, "{}", serde_json::to_string(&reply).unwrap()).unwrap();
            true
        })
    }

    #[cfg(windows)]
    #[test]
    fn bind_refuses_a_live_pre_lock_windows_daemon() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-pre-lock.endpoint");
        let daemon = spawn_pre_lock_daemon(&endpoint);
        let recorded = std::fs::read_to_string(&endpoint).unwrap();

        let err = bind(&endpoint).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
        assert!(
            daemon.join().unwrap(),
            "the probe never completed a handshake"
        );
        assert_eq!(std::fs::read_to_string(&endpoint).unwrap(), recorded);
        // No lock left behind, so the next start probes this daemon again
        // rather than trusting an unheld lock.
        assert!(!singleton_lock_path(&endpoint).exists());
    }

    #[cfg(windows)]
    #[test]
    fn bind_reclaims_a_lockless_endpoint_whose_port_never_handshakes() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-recycled.endpoint");
        // An unrelated listener on the recorded port: it accepts connections
        // but never answers, as a recycled port would.
        let unrelated = LocalListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let recorded = format!("{}\nstaletoken\n", unrelated.local_addr().unwrap());
        std::fs::write(&endpoint, &recorded).unwrap();

        let started = std::time::Instant::now();
        let _listener = bind(&endpoint).unwrap();

        assert!(started.elapsed() < Duration::from_secs(10));
        assert_ne!(std::fs::read_to_string(&endpoint).unwrap(), recorded);
    }

    #[cfg(windows)]
    #[test]
    fn bind_bounds_the_probe_of_a_lockless_endpoint_that_trickles_without_a_newline() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-trickle.endpoint");
        // A listener on the recorded port that accepts and then sends a byte
        // every 100ms, never a newline: each read succeeds well inside its
        // own timeout, so only a deadline on the whole probe stops it.
        let peer = LocalListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let recorded = format!("{}\nstaletoken\n", peer.local_addr().unwrap());
        std::fs::write(&endpoint, &recorded).unwrap();
        let trickle = std::thread::spawn(move || {
            let (mut stream, _) = peer.accept().unwrap();
            let stop = std::time::Instant::now() + PRE_LOCK_PROBE_TIMEOUT * 4;
            while std::time::Instant::now() < stop && stream.write_all(b"x").is_ok() {
                std::thread::sleep(Duration::from_millis(100));
            }
        });

        let started = std::time::Instant::now();
        let _listener = bind(&endpoint).unwrap();
        let waited = started.elapsed();

        assert!(
            waited < PRE_LOCK_PROBE_TIMEOUT + Duration::from_secs(1),
            "probe ran {waited:?}, past its {PRE_LOCK_PROBE_TIMEOUT:?} deadline"
        );
        assert_ne!(std::fs::read_to_string(&endpoint).unwrap(), recorded);
        trickle.join().unwrap();
    }

    /// The loopback address `bind` published at `endpoint`, for a client that
    /// connects without going through `connect`'s token line.
    #[cfg(windows)]
    fn published_address(endpoint: &Path) -> std::net::SocketAddr {
        std::fs::read_to_string(endpoint)
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    /// Serve one connection through `accept`: answer its "ping" with "pong".
    #[cfg(windows)]
    fn spawn_ping_server(listener: LocalListener, endpoint: &Path) -> std::thread::JoinHandle<()> {
        let endpoint = endpoint.to_path_buf();
        std::thread::spawn(move || {
            let (mut stream, _) = accept(&listener, &endpoint).unwrap();
            let mut bytes = [0_u8; 4];
            stream.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, b"ping");
            stream.write_all(b"pong").unwrap();
        })
    }

    /// Connect through `connect`, round-trip a ping, and return how long the
    /// client waited to be served.
    #[cfg(windows)]
    fn ping_through_connect(endpoint: &Path) -> Duration {
        let started = std::time::Instant::now();
        let mut client = connect(endpoint).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        client.write_all(b"ping").unwrap();
        let mut bytes = [0_u8; 4];
        client.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"pong");
        started.elapsed()
    }

    #[cfg(windows)]
    #[test]
    fn accept_serves_a_client_queued_behind_one_that_trickles_without_a_newline() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-accept-trickle.endpoint");
        let listener = bind(&endpoint).unwrap();
        // Connected first, so `accept` takes it first: it sends a byte every
        // 100ms and never a newline, so each read succeeds well inside any
        // per-read timeout and only a deadline on the whole token line stops
        // it. Accept's token deadline is 2s; this trickles for 10s.
        let mut trickler = LocalStream::connect(published_address(&endpoint)).unwrap();
        let trickle = std::thread::spawn(move || {
            let stop = std::time::Instant::now() + Duration::from_secs(10);
            while std::time::Instant::now() < stop && trickler.write_all(b"x").is_ok() {
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        let server = spawn_ping_server(listener, &endpoint);

        let waited = ping_through_connect(&endpoint);

        assert!(
            waited < Duration::from_secs(3),
            "a well-behaved client waited {waited:?} behind a trickling one"
        );
        server.join().unwrap();
        trickle.join().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn accept_drops_an_oversized_token_and_serves_the_next_client() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-accept-oversized.endpoint");
        let listener = bind(&endpoint).unwrap();
        // Connected first: a token line far past the 64-byte token with no
        // newline, then the connection is held open. It is wrong long before
        // its end, so `accept` must drop it at the cap rather than drain it
        // and then sit out a read timeout before serving the next client.
        let mut oversized = LocalStream::connect(published_address(&endpoint)).unwrap();
        oversized.write_all(&[b'x'; 4096]).unwrap();
        oversized.flush().unwrap();
        let server = spawn_ping_server(listener, &endpoint);

        let waited = ping_through_connect(&endpoint);

        assert!(
            waited < Duration::from_secs(1),
            "a well-behaved client waited {waited:?} behind an oversized token"
        );
        server.join().unwrap();
        // The oversized connection was dropped, not left half-read: its peer
        // sees the close.
        oversized
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut byte = [0_u8; 1];
        match oversized.read(&mut byte) {
            Ok(0) => {}
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
                ) => {}
            other => panic!("the oversized connection was not dropped: {other:?}"),
        }
    }
}
