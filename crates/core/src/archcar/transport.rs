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

#[cfg(windows)]
pub fn bind(endpoint: &Path) -> io::Result<LocalListener> {
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
    fn bind_refuses_live_unix_endpoint() {
        let temp = tempfile::tempdir().unwrap();
        let endpoint = temp.path().join("archcar-live.endpoint");
        let _listener = bind(&endpoint).unwrap();

        let err = bind(&endpoint).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
    }
}
