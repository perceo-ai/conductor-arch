//! `configured_listen_addr` must honor `ARCHDUCTOR_ARCHCAR_LISTEN` over the
//! address saved when remote access was enabled.
//!
//! The unit tests drive `resolve_listen_addr` with the env value passed in, so
//! they never see the real environment read. This binary sets the variable for
//! its own process instead; it is the only test here, so nothing else in the
//! suite can observe or race the change.

use archductor_core::archcar::remote;
use archductor_core::paths::AppPaths;
use std::net::SocketAddr;

#[test]
fn configured_listen_addr_prefers_the_env_over_the_saved_address() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let state_dir = root.join("state");
    let paths = AppPaths {
        config_dir: root.join("config"),
        data_dir: root.join("data"),
        database_path: root.join("data/archductor.db"),
        logs_dir: state_dir.join("logs"),
        cache_dir: root.join("cache"),
        state_dir,
    };
    let saved: SocketAddr = "127.0.0.1:7999".parse().unwrap();
    remote::save_listen_addr(&paths, Some(&saved)).unwrap();

    std::env::set_var(remote::LISTEN_ENV, "127.0.0.1:7420");

    let addr = remote::configured_listen_addr(&paths)
        .expect("a listen address should be configured")
        .expect("the env listen address should parse");
    assert_eq!(
        addr,
        "127.0.0.1:7420".parse::<SocketAddr>().unwrap(),
        "configured_listen_addr ignored {} and fell back to the saved address",
        remote::LISTEN_ENV
    );
}
