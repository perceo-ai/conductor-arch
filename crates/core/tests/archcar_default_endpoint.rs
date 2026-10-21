//! A daemon started on the default endpoint must refuse a path that already
//! has a live listener rather than unlink it and take it over.
//!
//! This resolves the endpoint through the real `AppPaths::from_env()`, so it
//! edits the process environment; it is the only test in this binary to keep
//! that single-threaded. Every XDG directory (`XDG_RUNTIME_DIR` too: it is the
//! first base of the short-socket fallback) and `HOME` point into a tempdir
//! first, so the developer's own state dir is never touched.
#![cfg(unix)]

use archductor_core::archcar::server::ArchcarServer;
use archductor_core::archcar::{handoff, remote};
use archductor_core::paths::AppPaths;
use std::os::unix::net::{UnixListener, UnixStream};

#[test]
fn serve_on_the_default_endpoint_refuses_a_live_listener() {
    // Not `tempdir()`: a long `TMPDIR` would push the direct socket path past
    // the unix limit and onto the short fallback, so root it at a short path.
    let temp = tempfile::Builder::new()
        .prefix("archcar-default-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = temp.path();
    for name in [
        remote::LISTEN_ENV,
        remote::REMOTE_ENV,
        remote::TOKEN_ENV,
        handoff::LOCAL_FD_ENV,
        handoff::REMOTE_FD_ENV,
    ] {
        std::env::remove_var(name);
    }
    std::env::set_var("HOME", root.join("home"));
    std::env::set_var("XDG_CONFIG_HOME", root.join("xdg/config"));
    std::env::set_var("XDG_DATA_HOME", root.join("xdg/data"));
    std::env::set_var("XDG_STATE_HOME", root.join("xdg/state"));
    std::env::set_var("XDG_CACHE_HOME", root.join("xdg/cache"));
    std::env::set_var("XDG_RUNTIME_DIR", root.join("xdg/runtime"));

    let paths = AppPaths::from_env();
    let endpoint = paths.archcar_endpoint_path();
    assert_eq!(
        endpoint,
        root.join("xdg/state/archductor/archcar.sock"),
        "from_env should resolve the default-shaped endpoint inside the test's tempdir"
    );
    std::fs::create_dir_all(endpoint.parent().unwrap()).unwrap();
    let live = UnixListener::bind(&endpoint).unwrap();

    let err = match ArchcarServer::bind(paths) {
        Ok(_) => panic!("a second daemon bound over a live listener"),
        Err(err) => err,
    };

    assert!(
        format!("{err:#}").contains("already has a live listener"),
        "expected a live-listener error, got: {err:#}"
    );
    assert!(
        endpoint.exists(),
        "the live listener's socket file was removed"
    );
    let _client = UnixStream::connect(&endpoint).expect("the live listener stopped accepting");
    live.accept()
        .expect("the connection should reach the original listener");
}
