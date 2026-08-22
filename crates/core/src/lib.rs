pub mod agent_tools;
pub mod archcar;
pub mod background_tasks;
pub mod chat_attachments;
pub mod chat_store;
pub mod codex_tui;
pub mod doctor;
pub mod env_flags;
pub mod git_review_service;
pub mod github_actions;
pub mod github_pr;
pub mod harness;
pub mod import;
pub mod linear;
pub mod local_chat;
pub mod mcp;
pub mod mcp_server;
pub mod model_registry;
pub mod paths;
pub mod platform;
pub mod provider_adapters;
pub mod provider_capabilities;
pub mod provider_events;
pub mod provider_inputs;
pub mod provider_interactions;
pub mod provider_projection;
pub mod pty;
pub mod redaction;
pub mod repository;
pub mod runtime_session_store;
pub mod service;
pub mod session_event;
pub mod session_kind;
pub mod session_pipeline;
pub mod session_state;
pub mod settings;
pub mod skill_catalog;
pub mod skill_sync;
pub mod skills;
pub mod storage;
pub mod terminal_logs;
pub mod todos;
pub mod workflow_actions;
pub mod workspace;
pub mod workspace_intel;

#[cfg(test)]
mod pty_tests {
    use std::env;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};
    use std::{fs, thread};

    const SIGTERM_HELPER_ENV: &str = "ARCHDUCTOR_SIGTERM_HELPER";

    #[test]
    fn pty_session_accepts_input_and_streams_output() {
        let temp = tempfile::tempdir().unwrap();
        let marker = "archductor-pty-ready";
        let mut session = crate::pty::PtySession::spawn(
            PathBuf::from("/bin/sh"),
            Vec::new(),
            temp.path(),
            vec![("LC_PTY_TEST_MARKER".to_owned(), OsString::from(marker))],
            24,
            80,
        )
        .unwrap();

        session
            .write("printf 'ready:%s\\n%s\\n' \"$PWD\" \"$LC_PTY_TEST_MARKER\"\n")
            .unwrap();
        let ready = session.read_until(marker, Duration::from_secs(2)).unwrap();
        assert!(ready.contains(temp.path().canonicalize().unwrap().to_str().unwrap()));

        session
            .write("read line; printf 'echo:%s\\n' \"$line\"; exit\n")
            .unwrap();
        session.write("from-pty\n").unwrap();
        let echoed = session
            .read_until("echo:from-pty", Duration::from_secs(2))
            .unwrap();

        assert!(echoed.contains("echo:from-pty"));
        session.stop().unwrap();
    }

    #[test]
    fn pty_session_resize_updates_child_terminal_size() {
        let temp = tempfile::tempdir().unwrap();
        let mut session = crate::pty::PtySession::spawn_shell(temp.path(), Vec::new()).unwrap();

        session.resize(33, 111).unwrap();
        session.write("stty size; exit\n").unwrap();
        let size = session
            .read_until("33 111", Duration::from_secs(2))
            .unwrap();

        assert!(size.contains("33 111"));
        session.stop().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pty_session_reports_child_unix_process_group() {
        let temp = tempfile::tempdir().unwrap();
        let mut session = crate::pty::PtySession::spawn(
            PathBuf::from("/bin/sh"),
            vec!["-c".to_owned(), "sleep 30".to_owned()],
            temp.path(),
            Vec::new(),
            24,
            80,
        )
        .unwrap();

        let child_pid = session.process_id().unwrap();
        assert_eq!(session.process_group_leader(), Some(child_pid));
        session.stop().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn platform_process_alive_tolerates_restricted_ps_on_unix() {
        let temp = tempfile::tempdir().unwrap();
        let ready = temp.path().join("ready.marker");
        let mut child = std::process::Command::new(env::current_exe().unwrap())
            .args(["--exact", "pty_tests::sleep_helper_process", "--nocapture"])
            .env("READY_MARKER", &ready)
            .env("SLEEP_HELPER", "1")
            .spawn()
            .unwrap();

        if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wait_for_file_contents(&ready, "ready");
        })) {
            let _ = child.kill();
            let _ = child.wait();
            std::panic::resume_unwind(panic);
        }
        assert!(crate::platform::process_alive(child.id()));
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn pty_stop_sends_sigterm_before_force_kill() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("term.marker");
        let ready = temp.path().join("ready.marker");
        let mut session = crate::pty::PtySession::spawn(
            env::current_exe().unwrap(),
            vec![
                "--exact".to_owned(),
                "pty_tests::sigterm_marker_helper_process".to_owned(),
                "--nocapture".to_owned(),
            ],
            temp.path(),
            vec![
                ("TERM_MARKER".to_owned(), marker.as_os_str().to_owned()),
                ("READY_MARKER".to_owned(), ready.as_os_str().to_owned()),
                (SIGTERM_HELPER_ENV.to_owned(), OsString::from("1")),
            ],
            24,
            80,
        )
        .unwrap();

        wait_for_file_contents(&ready, "ready");
        session.stop().unwrap();

        assert_eq!(std::fs::read_to_string(marker).unwrap(), "term\n");
    }

    #[cfg(unix)]
    #[test]
    fn sigterm_marker_helper_process() {
        if env::var_os(SIGTERM_HELPER_ENV).is_none() {
            return;
        }
        let marker = PathBuf::from(env::var_os("TERM_MARKER").unwrap());
        let ready = PathBuf::from(env::var_os("READY_MARKER").unwrap());
        ctrlc::set_handler(move || {
            let _ = fs::write(&marker, "term\n");
            std::process::exit(0);
        })
        .unwrap();
        fs::write(ready, "ready").unwrap();
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }

    #[cfg(unix)]
    #[test]
    fn sleep_helper_process() {
        if env::var_os("SLEEP_HELPER").is_none() {
            return;
        }
        let ready = PathBuf::from(env::var_os("READY_MARKER").unwrap());
        fs::write(ready, "ready").unwrap();
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }

    #[cfg(unix)]
    fn wait_for_file_contents(path: &Path, expected: &str) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if fs::read_to_string(path).is_ok_and(|contents| contents == expected) {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "timed out waiting for {} to contain {expected:?}",
            path.display()
        );
    }
}
