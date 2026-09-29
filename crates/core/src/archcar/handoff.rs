//! Restart archcar in place without ever closing its sockets.
//!
//! An update ends with the daemon running a new binary. Exiting and letting
//! systemd or launchd start it leaves a gap of a second or two in which the
//! socket is gone — and every local client treats "no daemon" as "start one",
//! so the first CLI command or desktop reconnect in that gap spawns its own
//! daemon, binds the socket, and the service manager's restart then fails
//! against it. Re-executing in place keeps the process (same PID, so the
//! service manager never notices) and hands the listening sockets to the new
//! image: connections that arrive mid-restart wait in the kernel's backlog and
//! the new binary accepts them.

use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;

/// Listening Unix socket handed to the next image, by fd number.
pub const LOCAL_FD_ENV: &str = "ARCHCAR_INHERITED_LOCAL_FD";
/// Listening TCP socket (the remote listener), when there is one.
pub const REMOTE_FD_ENV: &str = "ARCHCAR_INHERITED_REMOTE_FD";

/// Take a socket the previous image handed over, clearing the variable so a
/// process this daemon spawns never mistakes the number for its own.
pub fn take_inherited(env: &str) -> Option<OwnedFd> {
    let value = std::env::var(env).ok()?;
    std::env::remove_var(env);
    adopt(&value)
}

/// An fd number from the environment, if it names an open descriptor.
///
/// Checked rather than trusted: a stale variable with a number that happens to
/// be closed must not become an `OwnedFd`, which would later close whatever
/// reuses that number.
fn adopt(value: &str) -> Option<OwnedFd> {
    let fd: i32 = value.trim().parse().ok()?;
    if fd < 3 {
        return None;
    }
    // SAFETY: probing with F_GETFD; the borrow ends before any ownership claim.
    let borrowed = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) };
    rustix::io::fcntl_getfd(borrowed).ok()?;
    // Close-on-exec was cleared for the handoff; put it back, or every agent,
    // git, and script process this daemon spawns inherits the listening
    // sockets — and keeps them open after the daemon is gone, so clients
    // queue on a socket nobody will ever accept from.
    rustix::io::fcntl_setfd(borrowed, rustix::io::FdFlags::CLOEXEC).ok()?;
    // SAFETY: the descriptor is open, and was handed to this image for it
    // alone to own; nothing else in this process refers to it.
    Some(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Replace this process with `binary`, keeping the listening sockets open.
/// Only returns on failure, with the error; the caller falls back to exiting.
pub fn reexec(binary: &Path, local: &impl AsFd, remote: Option<&impl AsFd>) -> std::io::Error {
    use std::os::unix::process::CommandExt;

    let mut command = std::process::Command::new(binary);
    command.args(std::env::args_os().skip(1));
    for (env, fd) in [
        (LOCAL_FD_ENV, Some(local.as_fd())),
        (REMOTE_FD_ENV, remote.map(AsFd::as_fd)),
    ] {
        let Some(fd) = fd else {
            command.env_remove(env);
            continue;
        };
        // Rust opens every descriptor close-on-exec; these two must survive.
        if let Err(err) = rustix::io::fcntl_setfd(fd, rustix::io::FdFlags::empty()) {
            return err.into();
        }
        command.env(env, fd.as_raw_fd().to_string());
    }
    command.exec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};

    #[test]
    fn an_inherited_listener_keeps_accepting() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("archcar.sock");
        let original = UnixListener::bind(&path).unwrap();
        // What the next image sees: a bare number for a descriptor it now owns.
        let handed: OwnedFd = original.as_fd().try_clone_to_owned().unwrap();
        let number = handed.as_raw_fd().to_string();
        std::mem::forget(handed);
        drop(original);

        // A client that connects "mid-restart" is queued, not refused.
        let mut client = UnixStream::connect(&path).unwrap();
        let adopted = UnixListener::from(adopt(&number).expect("fd is open"));
        // Children the new image spawns must not inherit the listener.
        assert!(rustix::io::fcntl_getfd(&adopted)
            .unwrap()
            .contains(rustix::io::FdFlags::CLOEXEC));
        let (mut served, _) = adopted.accept().unwrap();
        client.write_all(b"ping").unwrap();
        let mut buffer = [0_u8; 4];
        served.read_exact(&mut buffer).unwrap();
        assert_eq!(&buffer, b"ping");
    }

    // A closed-number case is deliberately absent: other test threads open
    // descriptors concurrently, so "closed" cannot be made to hold, and
    // adopting a reused number would close another test's file.
    #[test]
    fn a_bogus_number_is_not_adopted() {
        assert!(adopt("not-a-number").is_none());
        assert!(adopt("1").is_none(), "stdio is never a handed-over socket");
    }
}
