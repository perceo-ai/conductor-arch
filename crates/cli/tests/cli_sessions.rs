#[cfg(unix)]
use archductor_core::archcar::handoff;
use archductor_core::archcar::harness::managed_harness_for_kind;
use archductor_core::archcar::harness_contract::{HarnessCapability, HarnessFeature, SupportMode};
use archductor_core::archcar::remote;
use archductor_core::provider_events::{
    ProviderEventDraft, ProviderEventKind, ProviderEventPhase, ProviderEventStore,
};
use archductor_core::workspace::{SessionKind, WorkspaceStore};
use assert_cmd::Command as AssertCommand;
use predicates::prelude::PredicateBooleanExt;
use predicates::str::contains;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn cli_starts_and_logs_real_shell_session() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let fake_shell = temp.path().join("fake-shell");
    // Stays running after it logs, so `attach` below meets a live session. A
    // shell that exited at once left the row's status to a race: the
    // short-lived `session start` CLI records the exit from a monitor thread
    // only if it is still alive when the shell dies, so a slow CLI exit turned
    // the attach into "no running session found". The sleep is bounded so a
    // failed assertion cannot leak it for long; the test stops it at the end.
    fs::write(
        &fake_shell,
        "#!/bin/sh\nprintf 'cli-session:%s:%s\\n' \"$ARCHDUCTOR_WORKSPACE_NAME\" \"$ARCHDUCTOR_PORT\"\nexec sleep 60\n",
    )
    .unwrap();
    Command::new("chmod")
        .arg("+x")
        .arg(&fake_shell)
        .status()
        .unwrap();

    app(temp.path())
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app(temp.path())
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();

    let started = app(temp.path())
        .env("SHELL", &fake_shell)
        .args(["session", "start", "berlin", "--kind", "shell"])
        .assert()
        .success()
        .stdout(contains("Started session for berlin"));
    let pid = started_session_pid(&String::from_utf8_lossy(&started.get_output().stdout));

    wait_for_session_log(temp.path());
    // The attach must judge a session that is really running; the PTY check
    // is what this test is about, not a stale row for a process already gone.
    assert!(
        archductor_core::platform::process_alive(pid),
        "session pid {pid} exited before attach; the attach would race the start CLI's exit"
    );
    app(temp.path())
        .args(["session", "attach", "berlin", "--print-pty-path"])
        .assert()
        .failure()
        .stderr(contains(format!(
            "process {pid} is not attached to a PTY slave"
        )));
    app(temp.path())
        .args(["logs", "berlin", "--session"])
        .assert()
        .success()
        .stdout(contains("cli-session:berlin:"));
    app(temp.path())
        .args(["session", "stop", "berlin"])
        .assert()
        .success()
        .stdout(contains(format!("Stopped session for berlin (pid {pid})")));
    assert!(!archductor_core::platform::process_alive(pid));
}

#[test]
fn cli_session_attach_names_the_dead_pid_when_the_shell_exits_after_start_returns() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let fake_shell = temp.path().join("fake-shell");
    let release = temp.path().join("release-start-outlive");
    // Blocks until the test writes `release`, so the shell is guaranteed to
    // outlive the short-lived `session start` CLI, then exits on its own with
    // no monitor thread left to record the exit: the row still says running
    // until `attach` reads it. The wait is bounded (600 x 0.05s, ~30s) so a
    // test that panics before releasing never leaks the shell indefinitely.
    // The script finds `release` next to itself via `$0` rather than having
    // the path pasted into its text, so a temp dir containing `$`, quotes or
    // spaces is never re-parsed as shell syntax.
    fs::write(
        &fake_shell,
        "#!/bin/sh\nprintf 'cli-session:%s:%s\\n' \"$ARCHDUCTOR_WORKSPACE_NAME\" \"$ARCHDUCTOR_PORT\"\nrelease=\"$(dirname \"$0\")/release-start-outlive\"\nfor i in $(seq 1 600); do [ -f \"$release\" ] && break; sleep 0.05; done\n",
    )
    .unwrap();
    Command::new("chmod")
        .arg("+x")
        .arg(&fake_shell)
        .status()
        .unwrap();

    app(temp.path())
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app(temp.path())
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();

    let started = app(temp.path())
        .env("SHELL", &fake_shell)
        .args(["session", "start", "berlin", "--kind", "shell"])
        .assert()
        .success()
        .stdout(contains("Started session for berlin"));
    let pid = started_session_pid(&String::from_utf8_lossy(&started.get_output().stdout));

    wait_for_session_log(temp.path());
    assert!(
        archductor_core::platform::process_alive(pid),
        "session pid {pid} exited before the start CLI returned; this would not exercise the race"
    );
    // The race has been exercised; release the fake shell so it exits. Its
    // own loop is bounded to ~30s, so a panic above does not leak it.
    fs::write(&release, "").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while archductor_core::platform::process_alive(pid) {
        assert!(
            Instant::now() < deadline,
            "session pid {pid} was still alive after 10s"
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    app(temp.path())
        .args(["session", "attach", "berlin", "--print-pty-path"])
        .assert()
        .failure()
        .stderr(
            // The only session in a fresh store is #1; naming it is the
            // point, so pin the whole message, not just the pid suffix.
            contains(format!(
                "session #1 for workspace berlin is no longer running (pid {pid} has exited)"
            ))
            .and(contains("is not attached to a PTY slave").not())
            .and(contains("no running session found for workspace berlin").not()),
        );
}

/// The pid from `session start`'s "Started session for <ws> as pid <pid> (...)".
fn started_session_pid(stdout: &str) -> u32 {
    stdout
        .split_once(" as pid ")
        .and_then(|(_, rest)| rest.split_whitespace().next())
        .and_then(|pid| pid.parse().ok())
        .unwrap_or_else(|| panic!("no pid in session start output: {stdout:?}"))
}

#[cfg(unix)]
#[test]
fn cli_archcar_shell_accepts_raw_terminal_pwd_and_stops() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let _archcar = ArchcarDaemon::start(temp.path(), &[("SHELL", Path::new("/bin/sh"))]);

    app(temp.path())
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app(temp.path())
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();

    app(temp.path())
        .env("SHELL", "/bin/sh")
        .args(["archcar", "spawn", "berlin", "--kind", "shell"])
        .assert()
        .success()
        .stdout(contains("Shell session for berlin"));
    let session_id = wait_for_running_session(temp.path(), "berlin");

    app(temp.path())
        .args([
            "archcar",
            "send",
            &session_id.to_string(),
            "--kind",
            "raw-terminal",
            "pwd\n",
        ])
        .assert()
        .success()
        .stdout(contains("ok"));

    let workspace_path = workspace_parent.join("berlin").canonicalize().unwrap();
    wait_for_archcar_screen_contains(temp.path(), session_id, workspace_path.to_str().unwrap());

    app(temp.path())
        .args(["archcar", "kill", &session_id.to_string()])
        .assert()
        .success()
        .stdout(contains("ok"));
    wait_for_session_exit(temp.path(), session_id);
}

#[test]
fn cli_exports_and_imports_repository_settings() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let conductor_dir = repo_path.join(".archductor");
    fs::create_dir(&conductor_dir).unwrap();
    fs::write(
        conductor_dir.join("settings.toml"),
        r#"
[scripts]
run = "cargo run"

[customization.view]
keybindings = "vim"
colors = {}
notification_rules = []
command_palette_presets = []

[prompts]
general = "Before import"
"#,
    )
    .unwrap();
    let export_path = temp.path().join("settings-export.toml");

    app(temp.path())
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app(temp.path())
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();
    app(temp.path())
        .args([
            "repo",
            "settings",
            "demo",
            "export",
            "--output",
            export_path.to_str().unwrap(),
        ])
        .assert()
        .success()
        .stdout(contains("Exported shared settings"));

    let exported = fs::read_to_string(&export_path).unwrap();
    assert!(exported.contains("keybindings = \"vim\""));
    fs::write(
        &export_path,
        exported.replace("Before import", "After import"),
    )
    .unwrap();

    app(temp.path())
        .args([
            "repo",
            "settings",
            "demo",
            "import",
            export_path.to_str().unwrap(),
            "--local",
        ])
        .assert()
        .success()
        .stdout(contains("Imported local settings"));

    let local_settings = fs::read_to_string(conductor_dir.join("settings.local.toml")).unwrap();
    assert!(local_settings.contains("keybindings = \"vim\""));
    assert!(local_settings.contains("[customization.view.colors]"));
    assert!(local_settings.contains("notification_rules = []"));
    assert!(local_settings.contains("command_palette_presets = []"));
    assert!(
        fs::read_to_string(workspace_parent.join("berlin/.context/PROMPTS.md"))
            .unwrap()
            .contains("After import")
    );
}

#[test]
fn cli_app_shared_import_export_preserves_explicit_empty_collections() {
    let temp = tempfile::tempdir().unwrap();
    let input = temp.path().join("shared-input.toml");
    let output = temp.path().join("shared-output.toml");
    fs::write(
        &input,
        r#"
file_include_globs = ""
env_file_refs = ""

[environment_variables]

[customization.view]
colors = {}
notification_rules = []
command_palette_presets = []
"#,
    )
    .unwrap();

    app(temp.path())
        .args(["settings", "import", input.to_str().unwrap()])
        .assert()
        .success();
    app(temp.path())
        .args(["settings", "export", "--output", output.to_str().unwrap()])
        .assert()
        .success();

    let exported = fs::read_to_string(output).unwrap();
    assert!(exported.contains("file_include_globs = \"\""));
    assert!(exported.contains("env_file_refs = \"\""));
    assert!(exported.contains("[environment_variables]"));
    assert!(exported.contains("[customization.view.colors]"));
    assert!(exported.contains("notification_rules = []"));
    assert!(exported.contains("command_palette_presets = []"));
}

#[test]
fn cli_session_open_print_command_uses_explicit_provider_models() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");

    app(temp.path())
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app(temp.path())
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();

    app(temp.path())
        .args([
            "session",
            "open",
            "berlin",
            "--kind",
            "codex",
            "--model",
            "gpt-5.6-sol",
            "--print-command",
        ])
        .assert()
        .success()
        .stdout(contains(
            "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox",
        ))
        .stdout(contains("--model gpt-5.6-sol"));

    app(temp.path())
        .args([
            "session",
            "open",
            "berlin",
            "--kind",
            "claude",
            "--model",
            "claude-sonnet-5",
            "--print-command",
        ])
        .assert()
        .success()
        .stdout(contains(
            "claude --permission-mode bypassPermissions --dangerously-skip-permissions",
        ))
        .stdout(contains("--model claude-sonnet-5"));
}

#[test]
fn cli_session_open_applies_app_shared_launch_settings() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let shared_settings = temp.path().join("xdg/config/archductor/settings.toml");
    fs::create_dir_all(shared_settings.parent().unwrap()).unwrap();
    fs::write(
        shared_settings,
        r#"
codex_executable_path = "/shared/bin/codex"

[environment_variables]
SHARED_SESSION_VALUE = "from-app-shared"
"#,
    )
    .unwrap();

    app(temp.path())
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app(temp.path())
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();

    app(temp.path())
        .args([
            "session",
            "open",
            "berlin",
            "--kind",
            "codex",
            "--print-command",
        ])
        .assert()
        .success()
        .stdout(contains("SHARED_SESSION_VALUE=from-app-shared"))
        .stdout(contains("exec /shared/bin/codex"));
}

#[test]
fn cli_session_send_hides_general_prompt_while_provider_receives_first_turn_prefix() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let fake_codex = fake_codex_path(temp.path());
    let provider_inputs = temp.path().join("provider-inputs.txt");
    let fake_home = temp.path().join("home");
    write_fake_codex(&fake_codex).unwrap();
    let _archcar = ArchcarDaemon::start(
        temp.path(),
        &[
            ("HOME", &fake_home),
            ("USERPROFILE", &fake_home),
            ("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs),
        ],
    );

    app_with_home(temp.path(), &fake_home)
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app_with_home(temp.path(), &fake_home)
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();
    fs::write(
        repo_path.join(".archductor/settings.local.toml"),
        format!(
            "codex_executable_path = {:?}\n\n[prompts]\ngeneral = \"Keep changes focused.\"\n",
            fake_codex.to_string_lossy()
        ),
    )
    .unwrap();

    app_with_home(temp.path(), &fake_home)
        .env("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs)
        .args([
            "session",
            "send",
            "berlin",
            "--kind",
            "codex",
            "--timeout-ms",
            "5000",
            "Fix auth",
        ])
        .assert()
        .success();
    wait_for_file_lines(&provider_inputs, 1);

    let store = WorkspaceStore::open(app_database_path(temp.path())).unwrap();
    let thread = store
        .list_chat_threads("berlin")
        .unwrap()
        .into_iter()
        .find(|thread| thread.provider == "codex")
        .unwrap();
    let first_session = store.list_sessions("berlin").unwrap()[0].id;
    app_with_home(temp.path(), &fake_home)
        .env("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs)
        .args(["archcar", "kill", &first_session.to_string()])
        .assert()
        .success();
    wait_for_session_exit(temp.path(), first_session);

    app_with_home(temp.path(), &fake_home)
        .env("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs)
        .args([
            "session",
            "send",
            "berlin",
            "--kind",
            "codex",
            "--thread-id",
            &thread.id.to_string(),
            "--timeout-ms",
            "5000",
            "Run tests",
        ])
        .assert()
        .success();
    wait_for_file_lines(&provider_inputs, 2);

    let captured = fs::read_to_string(&provider_inputs).unwrap();
    let captured = captured
        .lines()
        .map(|line| serde_json::from_str::<String>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        captured,
        vec!["Keep changes focused.\n\nFix auth", "Run tests"]
    );

    let visible_messages =
        wait_for_visible_user_messages(temp.path(), thread.id, &["Fix auth", "Run tests"]);
    assert!(visible_messages
        .iter()
        .all(|message| !message.content.contains("Keep changes focused.")));
    let second_session = store
        .list_sessions("berlin")
        .unwrap()
        .into_iter()
        .find(|session| session.id != first_session)
        .unwrap()
        .id;
    app_with_home(temp.path(), &fake_home)
        .env("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs)
        .args(["archcar", "kill", &second_session.to_string()])
        .assert()
        .success();
    wait_for_session_exit(temp.path(), second_session);
}

/// Failure this guards: `session send` to an agent mid-turn used to wait for the
/// session to become ready and fail with "timed out waiting for session", so an
/// operator could not steer exactly when it mattered. Now the message is queued
/// and lands at the next turn boundary, and `status`/`chat` report the busy
/// agent as working.
#[cfg(unix)]
#[test]
fn cli_session_send_to_a_busy_agent_queues_until_the_turn_ends() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let fake_codex = temp.path().join("fake-busy-codex");
    let provider_inputs = temp.path().join("provider-inputs.txt");
    let release = temp.path().join("release-first-turn");
    let fake_home = temp.path().join("home");
    write_fake_busy_codex(&fake_codex).unwrap();
    let _archcar = ArchcarDaemon::start(
        temp.path(),
        &[
            ("HOME", &fake_home),
            ("USERPROFILE", &fake_home),
            ("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs),
            ("ARCHDUCTOR_RELEASE_PATH", &release),
        ],
    );
    let app = || {
        let mut command = app_with_home(temp.path(), &fake_home);
        command
            .env("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs)
            .env("ARCHDUCTOR_RELEASE_PATH", &release);
        command
    };

    app()
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app()
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();
    fs::write(
        repo_path.join(".archductor/settings.local.toml"),
        format!(
            "codex_executable_path = {:?}\n",
            fake_codex.to_string_lossy()
        ),
    )
    .unwrap();

    app()
        .args([
            "session",
            "send",
            "berlin",
            "--kind",
            "codex",
            "--timeout-ms",
            "5000",
            "Start the long task",
        ])
        .assert()
        .success();
    wait_for_file_lines(&provider_inputs, 1);

    // Busy: the first turn is still open. Status says so. The daemon writes
    // the turn to the provider before it records the input and marks the
    // session working, so the provider can capture the input while status
    // still reads awaiting_input; wait for the daemon to catch up. The turn
    // cannot finish meanwhile: it is held until `release` exists, which is
    // written only further down.
    let status = wait_for_session_state(&app, "berlin", "working", "awaiting_input");
    let session = &status["workspaces"][0]["sessions"][0];
    assert_eq!(session["alive"], true, "{status}");
    assert_eq!(session["liveness_source"], "daemon", "{status}");

    // No --kind: the workspace's chat is a codex chat. A short timeout proves
    // nothing waits on the busy session.
    app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "1000",
            "Also run clippy",
        ])
        .assert()
        .success()
        .stdout(contains("queued codex message"))
        .stdout(contains("delivers at the next turn boundary"));
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(
        fs::read_to_string(&provider_inputs)
            .unwrap()
            .lines()
            .count(),
        1,
        "the queued message must wait for the turn to end"
    );

    fs::write(&release, "").unwrap();
    wait_for_file_lines(&provider_inputs, 2);
    let captured = fs::read_to_string(&provider_inputs)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<String>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(captured.len(), 2);
    // The queued message reaches the agent exactly as sent: no metadata
    // request appended, the same as a message that went straight in.
    assert!(captured[0].ends_with("Start the long task"), "{captured:?}");
    assert_eq!(captured[1], "Also run clippy", "{captured:?}");

    // The daemon records the delivered message just after the provider gets
    // it, so give the transcript a moment to catch up.
    let mut chat = String::new();
    for _ in 0..50 {
        let output = app()
            .args(["chat", "berlin", "--tail", "5"])
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        chat = String::from_utf8(output).unwrap();
        if chat.contains("user: Also run clippy") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(chat.starts_with("chat berlin thread "), "{chat}");
    assert!(chat.contains("user: Start the long task"), "{chat}");
    assert!(chat.contains("user: Also run clippy"), "{chat}");

    let store = WorkspaceStore::open(app_database_path(temp.path())).unwrap();
    let session_id = store.list_sessions("berlin").unwrap()[0].id;
    app()
        .args(["archcar", "kill", &session_id.to_string()])
        .assert()
        .success();
    wait_for_session_exit(temp.path(), session_id);
}

/// Failure this guards: when the daemon delivered a queued message at a turn
/// boundary, it handed the turn to the provider first and only afterwards
/// marked the session not ready. A `session send` landing in that gap read
/// `ready = true`, went straight in, and was steered into the turn that had
/// just started -- two prompts merged into one turn. The daemon now marks the
/// session busy before the handoff, so the send queues for the next turn.
///
/// The gap is a few milliseconds in a real daemon. The test daemon is built
/// with the `test-handoff-delay` seam, which stalls right after each handoff,
/// so the send below lands in the gap every time.
#[cfg(unix)]
#[test]
fn cli_session_send_while_a_queued_message_is_handed_off_queues_behind_it() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path().join("demo"));
    let fake_codex = temp.path().join("fake-held-codex");
    let provider_inputs = temp.path().join("provider-inputs.txt");
    let release = temp.path().join("release-turn");
    let fake_home = temp.path().join("home");
    write_fake_held_codex(&fake_codex).unwrap();
    let _archcar = ArchcarDaemon::start(
        temp.path(),
        &[
            ("HOME", &fake_home),
            ("USERPROFILE", &fake_home),
            ("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs),
            ("ARCHDUCTOR_RELEASE_PATH", &release),
            ("ARCHDUCTOR_TEST_HANDOFF_DELAY_MS", Path::new("1500")),
        ],
    );
    let app = || app_with_home(temp.path(), &fake_home);

    create_berlin_workspace(&app, temp.path(), "codex_executable_path", &fake_codex);

    app()
        .args([
            "session",
            "send",
            "berlin",
            "--kind",
            "codex",
            "--timeout-ms",
            "5000",
            "Start the long task",
        ])
        .assert()
        .success();
    wait_for_file_lines_through_stalls(&provider_inputs, 1);
    wait_for_session_state(&app, "berlin", "working", "awaiting_input");
    app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "1000",
            "Then the second task",
        ])
        .assert()
        .success()
        .stdout(contains("queued codex message"));

    // End turn 1. The daemon drains the queue and hands "Then the second
    // task" to the provider; the moment the provider has it, send again.
    fs::write(release.with_extension("1"), "").unwrap();
    wait_for_file_lines_through_stalls(&provider_inputs, 2);
    let output = app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "1000",
            "Then the third task",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let stdout = String::from_utf8(output).unwrap();
    assert!(
        stdout.contains("queued codex message"),
        "a send during the queued handoff must queue, not join the live turn: {stdout}"
    );

    // Turn 2 is still held: the third message waits, then opens turn 3.
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        fs::read_to_string(&provider_inputs)
            .unwrap()
            .lines()
            .count(),
        2,
        "the third message must wait for turn 2 to end"
    );
    fs::write(release.with_extension("2"), "").unwrap();
    wait_for_file_lines_through_stalls(&provider_inputs, 3);
    let captured = fs::read_to_string(&provider_inputs)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<(String, String)>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(captured.len(), 3, "{captured:?}");
    assert_eq!(captured[0].0, "turn/start", "{captured:?}");
    assert!(
        captured[0].1.ends_with("Start the long task"),
        "{captured:?}"
    );
    assert_eq!(
        captured[1],
        ("turn/start".to_owned(), "Then the second task".to_owned())
    );
    assert_eq!(
        captured[2],
        ("turn/start".to_owned(), "Then the third task".to_owned())
    );

    kill_berlin_session(&app, temp.path());
}

/// Failure this guards: the queue drain's own busy mark. It is the only thing
/// that covers the gap between the drain sending a queued input and the
/// session loop taking it: until the loop gets to the input, nothing else has
/// marked the session busy, so without the drain's mark a `session send` in
/// that gap read `ready = true` and went straight in behind the queued input.
///
/// The test above cannot tell the drain's mark from the codex loop's: both
/// run for the same delivery, and either closes its window. Here the loop is
/// stalled as it takes the input, before it marks anything, so the drain's
/// mark is all that stands between the third send and the live turn.
#[cfg(unix)]
#[test]
fn cli_session_send_while_the_queue_drain_hands_off_queues_behind_it() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path().join("demo"));
    let fake_codex = temp.path().join("fake-held-codex");
    let provider_inputs = temp.path().join("provider-inputs.txt");
    let release = temp.path().join("release-turn");
    let fake_home = temp.path().join("home");
    write_fake_held_codex(&fake_codex).unwrap();
    let _archcar = ArchcarDaemon::start(
        temp.path(),
        &[
            ("HOME", &fake_home),
            ("USERPROFILE", &fake_home),
            ("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs),
            ("ARCHDUCTOR_RELEASE_PATH", &release),
            ("ARCHDUCTOR_TEST_HANDOFF_DELAY_MS", Path::new("1500")),
            ("ARCHDUCTOR_TEST_HANDOFF_PICKUP_DELAY_MS", Path::new("1500")),
        ],
    );
    let app = || app_with_home(temp.path(), &fake_home);
    create_berlin_workspace(&app, temp.path(), "codex_executable_path", &fake_codex);

    app()
        .args([
            "session",
            "send",
            "berlin",
            "--kind",
            "codex",
            "--timeout-ms",
            "5000",
            "Start the long task",
        ])
        .assert()
        .success();
    wait_for_file_lines_through_stalls(&provider_inputs, 1);
    wait_for_session_state(&app, "berlin", "working", "awaiting_input");
    app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "1000",
            "Then the second task",
        ])
        .assert()
        .success()
        .stdout(contains("queued codex message"));

    // End turn 1. The drain claims "Then the second task" and sends it; the
    // loop sits on it unmarked. Send the moment the claim lands.
    fs::write(release.with_extension("1"), "").unwrap();
    wait_for_empty_chat_queue(temp.path(), "berlin");
    let output = app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "1000",
            "Then the third task",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let stdout = String::from_utf8(output).unwrap();
    assert!(
        stdout.contains("queued codex message"),
        "a send while the drain hands off must queue, not go straight in: {stdout}"
    );

    fs::write(release.with_extension("2"), "").unwrap();
    wait_for_file_lines_through_stalls(&provider_inputs, 3);
    let captured = fs::read_to_string(&provider_inputs)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<(String, String)>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        captured[1..],
        [
            ("turn/start".to_owned(), "Then the second task".to_owned()),
            ("turn/start".to_owned(), "Then the third task".to_owned()),
        ],
        "{captured:?}"
    );

    kill_berlin_session(&app, temp.path());
}

/// Failure this guards: the codex loop's own busy mark, on its own. A send to
/// an idle session with nothing queued goes straight to the session loop; the
/// daemon's queue drain never runs, so the loop's mark -- set before it writes
/// `turn/start` -- is the only thing that makes the next send queue. Without
/// it the next send read `ready = true` while the loop sat after the write,
/// and was steered into the live turn.
///
/// The first send is no use for this: it starts the session. The probe is
/// the send after turn 1 has finished.
#[cfg(unix)]
#[test]
fn cli_session_send_while_codex_takes_a_direct_send_queues_behind_it() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path().join("demo"));
    let fake_codex = temp.path().join("fake-held-codex");
    let provider_inputs = temp.path().join("provider-inputs.txt");
    let release = temp.path().join("release-turn");
    let fake_home = temp.path().join("home");
    write_fake_held_codex(&fake_codex).unwrap();
    let _archcar = ArchcarDaemon::start(
        temp.path(),
        &[
            ("HOME", &fake_home),
            ("USERPROFILE", &fake_home),
            ("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs),
            ("ARCHDUCTOR_RELEASE_PATH", &release),
            ("ARCHDUCTOR_TEST_HANDOFF_DELAY_MS", Path::new("1500")),
        ],
    );
    let app = || app_with_home(temp.path(), &fake_home);
    create_berlin_workspace(&app, temp.path(), "codex_executable_path", &fake_codex);

    app()
        .args([
            "session",
            "send",
            "berlin",
            "--kind",
            "codex",
            "--timeout-ms",
            "5000",
            "Start the long task",
        ])
        .assert()
        .success();
    wait_for_file_lines_through_stalls(&provider_inputs, 1);
    wait_for_session_state(&app, "berlin", "working", "awaiting_input");
    // Finish turn 1: idle, nothing queued, so the next send goes direct.
    // The loop marks the session ready itself; the daemon marks it ready
    // again when it handles the same `TurnCompleted`, and does so on its own
    // thread, later. Wait for that, or the late mark could clear the busy
    // mark of the send under test (a separate race this test is not about).
    let events = subscribe_to_archcar_events(temp.path());
    fs::write(release.with_extension("1"), "").unwrap();
    wait_for_archcar_event(&events, "turn_completed");
    wait_for_session_state(&app, "berlin", "finished", "working");
    app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "5000",
            "Then the second task",
        ])
        .assert()
        .success()
        // Straight in, not the queue route that also says "sent".
        .stdout(contains("sent codex message").and(contains("queued").not()));
    // The provider has turn 2; the loop is stalled just after writing it.
    wait_for_file_lines_through_stalls(&provider_inputs, 2);
    let output = app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "1000",
            "Then the third task",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let stdout = String::from_utf8(output).unwrap();
    assert!(
        stdout.contains("queued codex message"),
        "a send while codex takes a direct send must queue, not join the live turn: {stdout}"
    );

    fs::write(release.with_extension("2"), "").unwrap();
    wait_for_file_lines_through_stalls(&provider_inputs, 3);
    let captured = fs::read_to_string(&provider_inputs)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<(String, String)>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        captured[1..],
        [
            ("turn/start".to_owned(), "Then the second task".to_owned()),
            ("turn/start".to_owned(), "Then the third task".to_owned()),
        ],
        "{captured:?}"
    );

    kill_berlin_session(&app, temp.path());
}

/// Failure this guards: the claude stream loop had the same ordering bug as
/// codex -- it wrote the user message to claude's stdin and only then marked
/// the session busy -- so a send in that gap read `ready = true` and was
/// written into the live turn. Same shape as the codex test above: a direct
/// send to an idle claude session, where the loop's mark is the only one.
#[cfg(unix)]
#[test]
fn cli_session_send_while_claude_takes_a_direct_send_queues_behind_it() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path().join("demo"));
    let fake_claude = temp.path().join("fake-held-claude");
    let provider_inputs = temp.path().join("provider-inputs.txt");
    let release = temp.path().join("release-turn");
    let fake_home = temp.path().join("home");
    write_fake_held_claude(&fake_claude).unwrap();
    let _archcar = ArchcarDaemon::start(
        temp.path(),
        &[
            ("HOME", &fake_home),
            ("USERPROFILE", &fake_home),
            ("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs),
            ("ARCHDUCTOR_RELEASE_PATH", &release),
            ("ARCHDUCTOR_TEST_HANDOFF_DELAY_MS", Path::new("1500")),
        ],
    );
    let app = || app_with_home(temp.path(), &fake_home);
    create_berlin_workspace(
        &app,
        temp.path(),
        "claude_code_executable_path",
        &fake_claude,
    );

    // Claude's first message skips the readiness wait (it has no history to
    // wait behind), so a send racing the transport start can be refused.
    // Start the session and let it come up first; that race is not this one.
    app()
        .args(["session", "start", "berlin", "--kind", "claude"])
        .assert()
        .success();
    wait_for_archcar_ready(&app, wait_for_running_session(temp.path(), "berlin"));
    app()
        .args([
            "session",
            "send",
            "berlin",
            "--kind",
            "claude",
            "--timeout-ms",
            "5000",
            "Start the long task",
        ])
        .assert()
        .success();
    wait_for_file_lines_through_stalls(&provider_inputs, 1);
    wait_for_session_state(&app, "berlin", "working", "awaiting_input");
    // Finish turn 1: idle, nothing queued, so the next send goes direct.
    // The loop marks the session ready itself; the daemon marks it ready
    // again when it handles the same `TurnCompleted`, and does so on its own
    // thread, later. Wait for that, or the late mark could clear the busy
    // mark of the send under test (a separate race this test is not about).
    let events = subscribe_to_archcar_events(temp.path());
    fs::write(release.with_extension("1"), "").unwrap();
    wait_for_archcar_event(&events, "turn_completed");
    wait_for_session_state(&app, "berlin", "finished", "working");
    app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "5000",
            "Then the second task",
        ])
        .assert()
        .success()
        // Straight in, not the queue route that also says "sent".
        .stdout(contains("sent claude message").and(contains("queued").not()));
    wait_for_file_lines_through_stalls(&provider_inputs, 2);
    let output = app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "1000",
            "Then the third task",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let stdout = String::from_utf8(output).unwrap();
    assert!(
        stdout.contains("queued claude message"),
        "a send while claude takes a direct send must queue, not join the live turn: {stdout}"
    );

    fs::write(release.with_extension("2"), "").unwrap();
    wait_for_file_lines_through_stalls(&provider_inputs, 3);
    let captured = fs::read_to_string(&provider_inputs)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<(String, String)>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        captured[1..],
        [
            ("turn".to_owned(), "Then the second task".to_owned()),
            ("turn".to_owned(), "Then the third task".to_owned()),
        ],
        "{captured:?}"
    );

    kill_berlin_session(&app, temp.path());
}

/// Failure this guards: the daemon marks a session ready on `TurnCompleted`
/// as a safety net for a provider `Ready` that is delayed or lost. It does so
/// on its event pump, after the session loop has already marked the session
/// ready itself. A `session send` landing between the two opened the next
/// turn and marked the session busy for it; the daemon's late mark for the
/// turn before then set `ready = true` again while that turn was live, and
/// the send after it was steered into the live turn instead of queueing. The
/// late mark now checks the session's turn generation and leaves a newer
/// turn's busy mark alone.
///
/// The gap is the pump's latency in a real daemon. The test daemon is built
/// with the `test-handoff-delay` seams; one stalls the pump just before the
/// late mark, so the second send lands in the gap every time.
#[cfg(unix)]
#[test]
fn cli_session_send_after_a_late_turn_boundary_mark_queues_behind_the_live_turn() {
    let temp = tempfile::tempdir().unwrap();
    init_repo(temp.path().join("demo"));
    let fake_codex = temp.path().join("fake-held-codex");
    let provider_inputs = temp.path().join("provider-inputs.txt");
    let release = temp.path().join("release-turn");
    let fake_home = temp.path().join("home");
    write_fake_held_codex(&fake_codex).unwrap();
    let _archcar = ArchcarDaemon::start(
        temp.path(),
        &[
            ("HOME", &fake_home),
            ("USERPROFILE", &fake_home),
            ("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs),
            ("ARCHDUCTOR_RELEASE_PATH", &release),
            (
                "ARCHDUCTOR_TEST_TURN_BOUNDARY_MARK_DELAY_MS",
                Path::new("3000"),
            ),
        ],
    );
    let app = || app_with_home(temp.path(), &fake_home);

    create_berlin_workspace(&app, temp.path(), "codex_executable_path", &fake_codex);

    app()
        .args([
            "session",
            "send",
            "berlin",
            "--kind",
            "codex",
            "--timeout-ms",
            "5000",
            "Start the long task",
        ])
        .assert()
        .success();
    wait_for_file_lines_through_stalls(&provider_inputs, 1);
    wait_for_session_state(&app, "berlin", "working", "awaiting_input");

    // End turn 1. The loop marks the session ready at once; the daemon's own
    // mark for the same `TurnCompleted` is held back by the stall.
    let events = subscribe_to_archcar_events(temp.path());
    fs::write(release.with_extension("1"), "").unwrap();
    wait_for_session_state(&app, "berlin", "finished", "working");
    app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "1000",
            "Then the second task",
        ])
        .assert()
        .success()
        .stdout(contains("sent codex message"));
    // Turn 2 is open and held. Only once the provider has it is the session
    // marked busy for it -- the loop marks busy before it writes the turn.
    wait_for_file_lines_through_stalls(&provider_inputs, 2);
    // The race needs turn 2 open before the late mark; if the stall ever ran
    // out first, this test would pass without exercising it.
    assert!(
        !events
            .try_iter()
            .any(|event| event["type"] == "turn_completed"),
        "turn 1's late ready mark landed before turn 2 started; lengthen the stall"
    );
    // Let the late mark for turn 1 land. The daemon broadcasts the event
    // only after it has handled it.
    wait_for_archcar_event(&events, "turn_completed");

    let output = app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "1000",
            "Then the third task",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let stdout = String::from_utf8(output).unwrap();
    assert!(
        stdout.contains("queued codex message"),
        "a send after turn 1's late ready mark must queue behind turn 2, not join it: {stdout}"
    );

    // Turn 2 is still held: the third message waits, then opens turn 3.
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        fs::read_to_string(&provider_inputs)
            .unwrap()
            .lines()
            .count(),
        2,
        "the third message must wait for turn 2 to end"
    );
    fs::write(release.with_extension("2"), "").unwrap();
    wait_for_file_lines_through_stalls(&provider_inputs, 3);
    let captured = fs::read_to_string(&provider_inputs)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<(String, String)>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        captured[1..],
        [
            ("turn/start".to_owned(), "Then the second task".to_owned()),
            ("turn/start".to_owned(), "Then the third task".to_owned()),
        ],
        "{captured:?}"
    );

    kill_berlin_session(&app, temp.path());
}

/// Failure this guards: the daemon marks a session busy before it hands a
/// queued message to the session loop, trusting the loop to either start the
/// turn or mark the session failed. Two `continue` paths in the loop's
/// `SendInput` handler -- the first-turn history check failing, and (Codex
/// only) the app-server thread not being initialized -- did neither: they
/// emitted a `SessionError` and dropped the message, so no turn ever started,
/// no `TurnCompleted` ever cleared the busy state, and `status` reported the
/// session `working` forever. Those paths now mark the session failed, which
/// `archcar status` reports as `state=failed` and `status` as no longer live.
///
/// The test daemon is built with the `test-handoff-delay` seams; one of them
/// makes the first-turn history check fail once a marker file exists, so the
/// first send starts the session normally and only the queued one is dropped.
#[cfg(unix)]
#[test]
fn cli_session_queued_send_dropped_before_the_turn_starts_resolves_to_failed() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let fake_codex = temp.path().join("fake-held-codex");
    let provider_inputs = temp.path().join("provider-inputs.txt");
    let release = temp.path().join("release-turn");
    let force_error = temp.path().join("force-first-turn-check-error");
    let fake_home = temp.path().join("home");
    write_fake_held_codex(&fake_codex).unwrap();
    let _archcar = ArchcarDaemon::start(
        temp.path(),
        &[
            ("HOME", &fake_home),
            ("USERPROFILE", &fake_home),
            ("ARCHDUCTOR_CAPTURE_PATH", &provider_inputs),
            ("ARCHDUCTOR_RELEASE_PATH", &release),
            (
                "ARCHDUCTOR_TEST_FORCE_FIRST_TURN_CHECK_ERROR_PATH",
                &force_error,
            ),
        ],
    );
    let app = || app_with_home(temp.path(), &fake_home);

    app()
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app()
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();
    fs::write(
        repo_path.join(".archductor/settings.local.toml"),
        format!(
            "codex_executable_path = {:?}\n",
            fake_codex.to_string_lossy()
        ),
    )
    .unwrap();

    app()
        .args([
            "session",
            "send",
            "berlin",
            "--kind",
            "codex",
            "--timeout-ms",
            "5000",
            "Start the long task",
        ])
        .assert()
        .success();
    wait_for_file_lines(&provider_inputs, 1);
    wait_for_session_state(&app, "berlin", "working", "awaiting_input");
    app()
        .args([
            "session",
            "send",
            "berlin",
            "--timeout-ms",
            "1000",
            "Then the second task",
        ])
        .assert()
        .success()
        .stdout(contains("queued codex message"));

    let store = WorkspaceStore::open(app_database_path(temp.path())).unwrap();
    let session_id = store.list_sessions("berlin").unwrap()[0].id;

    // From here on the session loop's first-turn history check fails. End
    // turn 1: the daemon marks the session busy and hands "Then the second
    // task" to the loop, which drops it before starting a turn.
    fs::write(&force_error, "").unwrap();
    fs::write(release.with_extension("1"), "").unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let output = app()
            .args(["archcar", "status", &session_id.to_string()])
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        let daemon_status = String::from_utf8(output).unwrap();
        if daemon_status.contains("state=failed") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "a dropped send must resolve the session to failed, not leave it claiming a turn: {daemon_status}"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    // A failed session is no longer live, so `status` stops reporting it as
    // working; its state then comes from the last turn that actually ran.
    let output = app()
        .args(["status", "berlin", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let status: serde_json::Value = serde_json::from_slice(&output).unwrap();
    let session = &status["workspaces"][0]["sessions"][0];
    assert_eq!(session["alive"], false, "{status}");
    assert_ne!(session["state"], "working", "{status}");
    assert_eq!(
        fs::read_to_string(&provider_inputs)
            .unwrap()
            .lines()
            .count(),
        1,
        "the dropped message must never reach the provider: {status}"
    );

    app()
        .args(["archcar", "kill", &session_id.to_string()])
        .assert()
        .success();
    wait_for_session_exit(temp.path(), session_id);
}

/// Failure this guards: a provider that dies mid-handshake leaves the session
/// with `runtime_state = failed` while its process `status` still reads
/// `running`, and `session send` printed both side by side, e.g. "session 1 is
/// not running (status=running state=failed)" -- a message that contradicts
/// itself. The send must fail with a message that names the failed state and
/// does not also call the session running.
#[cfg(unix)]
#[test]
fn cli_session_send_to_a_provider_that_fails_its_handshake_reports_one_state() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let fake_codex = temp.path().join("fake-failing-codex");
    let fake_home = temp.path().join("home");
    write_fake_failing_codex(&fake_codex).unwrap();
    let _archcar = ArchcarDaemon::start(
        temp.path(),
        &[("HOME", &fake_home), ("USERPROFILE", &fake_home)],
    );
    let app = || app_with_home(temp.path(), &fake_home);

    app()
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app()
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();
    fs::write(
        repo_path.join(".archductor/settings.local.toml"),
        format!(
            "codex_executable_path = {:?}\n",
            fake_codex.to_string_lossy()
        ),
    )
    .unwrap();

    // The first send spawns the session; its readiness check runs while the
    // handshake is still in flight, so it is not the call under test.
    app()
        .args([
            "session",
            "send",
            "berlin",
            "--kind",
            "codex",
            "--timeout-ms",
            "5000",
            "hello",
        ])
        .output()
        .unwrap();
    let store = WorkspaceStore::open(app_database_path(temp.path())).unwrap();
    let record = store.list_sessions("berlin").unwrap()[0].clone();
    let session_id = record.id.to_string();
    let thread_id = record.chat_thread_id.unwrap().to_string();

    // Wait for the handshake failure to land: the daemon still reports the
    // process as running, but the provider state is failed.
    let mut status = String::new();
    for _ in 0..100 {
        let output = app()
            .args(["archcar", "status", &session_id])
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        status = String::from_utf8(output).unwrap();
        if status.contains("state=failed") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(status.contains("status=running"), "{status}");
    assert!(status.contains("state=failed"), "{status}");

    let output = app()
        .args([
            "session",
            "send",
            "berlin",
            "--kind",
            "codex",
            "--thread-id",
            &thread_id,
            "--timeout-ms",
            "5000",
            "hello again",
        ])
        .assert()
        .failure()
        .get_output()
        .clone();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("state=failed"), "{stderr}");
    assert!(
        !(stderr.contains("status=running") && stderr.contains("state=failed")),
        "the message must not call the failed session running: {stderr}"
    );
}

/// A codex app-server stand-in that answers `initialize` with an error, the
/// way a crashed or misconfigured provider fails its handshake.
#[cfg(unix)]
fn write_fake_failing_codex(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::write(
        path,
        r#"#!/usr/bin/env python3
import json
import sys

for raw in sys.stdin:
    message = json.loads(raw)
    if message.get("method") == "initialize":
        print(json.dumps({"id": message["id"], "error": {"message": "codex failed to start: port already in use"}}), flush=True)
"#,
    )?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

/// A codex app-server stand-in whose first turn stays open until
/// `$ARCHDUCTOR_RELEASE_PATH` exists; later turns complete at once.
#[cfg(unix)]
fn write_fake_busy_codex(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::write(
        path,
        r#"#!/usr/bin/env python3
import json
import os
import sys
import threading
import time

capture = os.environ["ARCHDUCTOR_CAPTURE_PATH"]
release = os.environ["ARCHDUCTOR_RELEASE_PATH"]
lock = threading.Lock()

def emit(message):
    with lock:
        print(json.dumps(message), flush=True)

def complete(turn_id):
    emit({"method": "turn/completed", "params": {"turn": {"id": turn_id, "status": "completed"}}})

def complete_when_released(turn_id):
    while not os.path.exists(release):
        time.sleep(0.05)
    complete(turn_id)

turns = 0
for raw in sys.stdin:
    message = json.loads(raw)
    method = message.get("method")
    if method == "initialize":
        emit({"id": message["id"], "result": {}})
    elif method in ("thread/start", "thread/resume"):
        emit({"id": message["id"], "result": {"thread": {"id": "thread-busy"}}})
    elif method == "turn/start":
        turns += 1
        with open(capture, "a", encoding="utf-8") as output:
            output.write(json.dumps(message["params"]["input"][0]["text"]) + "\n")
        turn_id = "turn-%d" % turns
        emit({"id": message["id"], "result": {"turn": {"id": turn_id}}})
        emit({"method": "turn/started", "params": {"turn": {"id": turn_id}}})
        if turns == 1:
            threading.Thread(target=complete_when_released, args=(turn_id,), daemon=True).start()
        else:
            complete(turn_id)
"#,
    )?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

/// A codex app-server stand-in that holds turn N open until
/// `$ARCHDUCTOR_RELEASE_PATH.N` exists, and records every input it receives
/// as a `[method, text]` line, so a steer into a live turn shows up as such.
#[cfg(unix)]
fn write_fake_held_codex(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::write(
        path,
        r#"#!/usr/bin/env python3
import json
import os
import sys
import threading
import time

capture = os.environ["ARCHDUCTOR_CAPTURE_PATH"]
release = os.environ["ARCHDUCTOR_RELEASE_PATH"]
lock = threading.Lock()

def emit(message):
    with lock:
        print(json.dumps(message), flush=True)

def record(method, params):
    with open(capture, "a", encoding="utf-8") as output:
        output.write(json.dumps([method, params["input"][0]["text"]]) + "\n")

def complete_when_released(turn, turn_id):
    while not os.path.exists("%s.%d" % (release, turn)):
        time.sleep(0.05)
    emit({"method": "turn/completed", "params": {"turn": {"id": turn_id, "status": "completed"}}})

turns = 0
for raw in sys.stdin:
    message = json.loads(raw)
    method = message.get("method")
    if method == "initialize":
        emit({"id": message["id"], "result": {}})
    elif method in ("thread/start", "thread/resume"):
        emit({"id": message["id"], "result": {"thread": {"id": "thread-held"}}})
    elif method == "turn/start":
        turns += 1
        record(method, message["params"])
        turn_id = "turn-%d" % turns
        emit({"id": message["id"], "result": {"turn": {"id": turn_id}}})
        emit({"method": "turn/started", "params": {"turn": {"id": turn_id}}})
        threading.Thread(target=complete_when_released, args=(turns, turn_id), daemon=True).start()
    elif method == "turn/steer":
        record(method, message["params"])
        emit({"id": message["id"], "result": {"turnId": "turn-%d" % turns}})
"#,
    )?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

/// A claude `--input-format stream-json` stand-in. Each user message that
/// arrives while no turn is open starts turn N, held until
/// `$ARCHDUCTOR_RELEASE_PATH.N` exists; one that arrives during a turn joins
/// it. Every message is recorded as a `["turn" | "joined", text]` line, so a
/// message merged into a live turn shows up as such.
#[cfg(unix)]
fn write_fake_held_claude(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::write(
        path,
        r#"#!/usr/bin/env python3
import json
import os
import sys
import threading
import time

capture = os.environ["ARCHDUCTOR_CAPTURE_PATH"]
release = os.environ["ARCHDUCTOR_RELEASE_PATH"]
lock = threading.Lock()
state = {"turns": 0, "open": False}

def emit(message):
    message["session_id"] = "fake-claude-session"
    with lock:
        print(json.dumps(message), flush=True)

def record(how, text):
    with open(capture, "a", encoding="utf-8") as output:
        output.write(json.dumps([how, text]) + "\n")

def complete_when_released(turn):
    while not os.path.exists("%s.%d" % (release, turn)):
        time.sleep(0.05)
    emit({"type": "assistant", "uuid": "assistant-%d" % turn, "message": {"id": "msg-%d" % turn, "role": "assistant", "content": [{"type": "text", "text": "done %d" % turn}]}})
    with lock:
        state["open"] = False
    emit({"type": "result", "subtype": "success", "uuid": "result-%d" % turn, "result": "done %d" % turn, "duration_ms": 1})

for raw in sys.stdin:
    message = json.loads(raw)
    if message.get("type") != "user":
        continue
    text = message["message"]["content"][0]["text"]
    with lock:
        joined = state["open"]
        if not joined:
            state["turns"] += 1
            state["open"] = True
        turn = state["turns"]
    if joined:
        record("joined", text)
        continue
    record("turn", text)
    if turn == 1:
        emit({"type": "system", "subtype": "init", "uuid": "init", "model": "claude-fixture"})
    threading.Thread(target=complete_when_released, args=(turn,), daemon=True).start()
"#,
    )?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

#[cfg(unix)]
fn fake_codex_path(root: &Path) -> PathBuf {
    root.join("fake-codex")
}

#[cfg(windows)]
fn fake_codex_path(root: &Path) -> PathBuf {
    root.join("fake-codex.cmd")
}

#[cfg(unix)]
fn write_fake_codex(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::write(
        path,
        r#"#!/usr/bin/env python3
import json
import os
import sys

def write_rollout(message):
    home = os.environ.get("HOME")
    if not home:
        return
    cwd = message.get("params", {}).get("cwd", ".")
    rollout_dir = os.path.join(home, ".codex", "sessions", "2026", "07", "19")
    os.makedirs(rollout_dir, exist_ok=True)
    rollout_path = os.path.join(rollout_dir, "rollout-thread-test.jsonl")
    meta = {"type": "session_meta", "payload": {"session_id": "thread-test", "cwd": cwd}}
    with open(rollout_path, "w", encoding="utf-8") as output:
        output.write(json.dumps(meta) + "\n")

capture = os.environ["ARCHDUCTOR_CAPTURE_PATH"]
for raw in sys.stdin:
    message = json.loads(raw)
    method = message.get("method")
    if method == "initialize":
        print(json.dumps({"id": message["id"], "result": {}}), flush=True)
    elif method in ("thread/start", "thread/resume"):
        write_rollout(message)
        print(json.dumps({"id": message["id"], "result": {"thread": {"id": "thread-test"}}}), flush=True)
    elif method == "turn/start":
        text = message["params"]["input"][0]["text"]
        with open(capture, "a", encoding="utf-8") as output:
            output.write(json.dumps(text) + "\n")
        turn_id = "turn-test"
        print(json.dumps({"id": message["id"], "result": {"turn": {"id": turn_id}}}), flush=True)
        print(json.dumps({"method": "turn/completed", "params": {"turn": {"id": turn_id, "status": "completed"}}}), flush=True)
"#,
    )?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

#[cfg(windows)]
fn write_fake_codex(path: &Path) -> std::io::Result<()> {
    let script = path.with_extension("ps1");
    fs::write(
        path,
        format!(
            "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"\r\n",
            script.display()
        ),
    )?;
    fs::write(
        script,
        r#"
$capture = $env:ARCHDUCTOR_CAPTURE_PATH
function Write-Rollout($message) {
  $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
  if (-not $homeDir) { return }
  $cwd = if ($message.params -and $message.params.cwd) { $message.params.cwd } else { "." }
  $rolloutDir = Join-Path $homeDir ".codex/sessions/2026/07/19"
  New-Item -ItemType Directory -Force -Path $rolloutDir | Out-Null
  $meta = @{ type = "session_meta"; payload = @{ session_id = "thread-test"; cwd = $cwd } }
  Set-Content -Path (Join-Path $rolloutDir "rollout-thread-test.jsonl") -Encoding UTF8 -Value ($meta | ConvertTo-Json -Compress -Depth 8)
}
while (($raw = [Console]::In.ReadLine()) -ne $null) {
  $message = $raw | ConvertFrom-Json
  $method = $message.method
  if ($method -eq "initialize") {
    Write-Output (@{ id = $message.id; result = @{} } | ConvertTo-Json -Compress -Depth 8)
  } elseif ($method -eq "thread/start" -or $method -eq "thread/resume") {
    Write-Rollout $message
    Write-Output (@{ id = $message.id; result = @{ thread = @{ id = "thread-test" } } } | ConvertTo-Json -Compress -Depth 8)
  } elseif ($method -eq "turn/start") {
    $text = $message.params.input[0].text
    Add-Content -Path $capture -Encoding UTF8 -Value ($text | ConvertTo-Json -Compress)
    $turnId = "turn-test"
    Write-Output (@{ id = $message.id; result = @{ turn = @{ id = $turnId } } } | ConvertTo-Json -Compress -Depth 8)
    Write-Output (@{ method = "turn/completed"; params = @{ turn = @{ id = $turnId; status = "completed" } } } | ConvertTo-Json -Compress -Depth 8)
  }
  [Console]::Out.Flush()
}
"#,
    )
}

#[test]
fn cli_archcar_messages_renders_projected_provider_events() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let _archcar = ArchcarDaemon::start(temp.path(), &[]);

    app(temp.path())
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app(temp.path())
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();

    let db_path = app_database_path(temp.path());
    let store = WorkspaceStore::open(&db_path).unwrap();
    let thread = store
        .create_chat_thread("berlin", "codex", "Codex", None)
        .unwrap();
    store
        .append_chat_message(thread.id, "user", "Run tests", "cli")
        .unwrap();
    let provider_store = ProviderEventStore::new(&db_path);
    provider_store
        .upsert_event(&provider_event(
            thread.id,
            "assistant-1",
            ProviderEventKind::AssistantOutput,
            ProviderEventPhase::Completed,
            "agent_message",
            "Assistant",
            "<arch\nTests passed",
        ))
        .unwrap();
    provider_store
        .upsert_event(&provider_event(
            thread.id,
            "reasoning-1",
            ProviderEventKind::PlanningReasoning,
            ProviderEventPhase::Progress,
            "reasoning_summary",
            "Reasoning",
            "Checking failure output",
        ))
        .unwrap();
    provider_store
        .upsert_event(&provider_event(
            thread.id,
            "turn-1",
            ProviderEventKind::Turn,
            ProviderEventPhase::Started,
            "turn_started",
            "Turn started",
            "raw lifecycle",
        ))
        .unwrap();

    app(temp.path())
        .args(["archcar", "messages", &thread.id.to_string()])
        .assert()
        .success()
        .stdout(contains("You\nRun tests\n\n"))
        .stdout(contains("Assistant\nTests passed\n\n"))
        .stdout(predicates::str::contains("<arch").not())
        .stdout(contains("Reasoning\nChecking failure output\n\n"))
        .stdout(predicates::str::contains("turn_started").not())
        .stdout(predicates::str::contains("raw lifecycle").not());
}

#[test]
fn cli_archcar_messages_hides_mcp_startup_status_provider_event() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let _archcar = ArchcarDaemon::start(temp.path(), &[]);

    app(temp.path())
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app(temp.path())
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();

    let db_path = app_database_path(temp.path());
    let store = WorkspaceStore::open(&db_path).unwrap();
    let thread = store
        .create_chat_thread("berlin", "codex", "Codex", None)
        .unwrap();
    let provider_store = ProviderEventStore::new(&db_path);
    provider_store
        .upsert_event(&provider_event(
            thread.id,
            "mcp-startup-status",
            ProviderEventKind::Mcp,
            ProviderEventPhase::Progress,
            "mcpServer/startupStatus/updated",
            "MCP loading",
            "",
        ))
        .unwrap();
    provider_store
        .upsert_event(&provider_event(
            thread.id,
            "mcp-startup-status",
            ProviderEventKind::Mcp,
            ProviderEventPhase::Completed,
            "mcpServer/startupStatus/updated",
            "MCP loaded",
            "github: ready",
        ))
        .unwrap();

    app(temp.path())
        .args(["archcar", "messages", &thread.id.to_string()])
        .assert()
        .success()
        .stdout(predicates::str::contains("MCP loaded").not())
        .stdout(predicates::str::contains("github: ready").not())
        .stdout(predicates::str::contains("MCP loading").not())
        .stdout(predicates::str::contains("mcpServer/startupStatus/updated").not());
}

#[test]
fn cli_archcar_messages_renders_claude_projected_provider_events() {
    let temp = tempfile::tempdir().unwrap();
    let repo_path = init_repo(temp.path().join("demo"));
    let workspace_parent = temp.path().join("workspaces/demo");
    let _archcar = ArchcarDaemon::start(temp.path(), &[]);

    app(temp.path())
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app(temp.path())
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();

    let db_path = app_database_path(temp.path());
    let store = WorkspaceStore::open(&db_path).unwrap();
    let thread = store
        .create_chat_thread("berlin", "claude", "Claude", None)
        .unwrap();
    let provider_store = ProviderEventStore::new(&db_path);
    let mut assistant_event = provider_event(
        thread.id,
        "assistant-1",
        ProviderEventKind::AssistantOutput,
        ProviderEventPhase::Completed,
        "assistant_message",
        "Assistant",
        "Claude answer",
    );
    assistant_event.provider = "claude".to_owned();
    provider_store.upsert_event(&assistant_event).unwrap();
    let mut tool_event = provider_event(
        thread.id,
        "tool-1",
        ProviderEventKind::Tool,
        ProviderEventPhase::Completed,
        "tool_result",
        "Tool",
        "Read file",
    );
    tool_event.provider = "claude".to_owned();
    provider_store.upsert_event(&tool_event).unwrap();

    app(temp.path())
        .args(["archcar", "messages", &thread.id.to_string()])
        .assert()
        .success()
        .stdout(contains("Assistant\nClaude answer\n\n"))
        .stdout(contains("Tool\nRead file\n\n"))
        .stdout(predicates::str::contains("\"method\"").not());
}

#[test]
fn claude_thread_session_send_help_exposes_thread_targeting() {
    let temp = tempfile::tempdir().unwrap();
    app(temp.path())
        .args(["session", "send", "--help"])
        .assert()
        .success()
        .stdout(contains("--thread-id"))
        .stdout(contains("claude"));
}

#[test]
fn claude_hook_hidden_command_prints_single_json_object() {
    let temp = tempfile::tempdir().unwrap();
    let output = app(temp.path())
        .args(["--archcar-claude-hook", "42"])
        .write_stdin(
            json!({
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "tool_input": {"command": "cargo test"}
            })
            .to_string(),
        )
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let stdout = String::from_utf8(output).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();

    assert_eq!(parsed, json!({}));
    assert_eq!(stdout.trim_end_matches('\n').lines().count(), 1);
}

// A root this long pushes `<root>/xdg/state/archductor/archcar.sock` past the
// unix socket path limit, so the endpoint falls back to `$XDG_RUNTIME_DIR`.
// That fallback must never be the operator's own runtime dir. It cannot be
// asserted to land inside the root: `xdg/runtime/archcar-<hash>.sock` is a
// longer suffix than `xdg/state/archductor/archcar.sock`, so any root that
// overflows the direct path overflows the runtime candidate too, and the
// endpoint falls through to a hashed temp-dir path instead.
#[cfg(unix)]
#[test]
fn archcar_endpoint_stays_out_of_operator_runtime_dir_for_a_long_test_root() {
    let operator_runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("x".repeat(120));
    fs::create_dir_all(&root).unwrap();
    let endpoint = archcar_endpoint_path(&root);

    if let Some(operator_dir) = &operator_runtime_dir {
        assert!(
            !endpoint.starts_with(operator_dir),
            "archcar endpoint {} leaked into the operator's real XDG_RUNTIME_DIR {}",
            endpoint.display(),
            operator_dir.display()
        );
    }
}

#[test]
fn provider_interactions_help_lists_cli_actions() {
    let temp = tempfile::tempdir().unwrap();
    app(temp.path())
        .args(["archcar", "interactions", "--help"])
        .assert()
        .success()
        .stdout(contains("list"))
        .stdout(contains("allow"))
        .stdout(contains("deny"))
        .stdout(contains("answer"));
}

#[test]
fn harness_capabilities_gate_goals_to_codex_descriptor() {
    let codex = managed_harness_for_kind(SessionKind::CODEX).unwrap();
    let claude = managed_harness_for_kind(SessionKind::CLAUDE).unwrap();

    assert_eq!(
        codex.descriptor().optional(HarnessCapability::Goals),
        SupportMode::Native
    );
    assert!(matches!(
        claude.descriptor().optional(HarnessCapability::Goals),
        SupportMode::Unsupported { reason } if !reason.is_empty()
    ));
    // Session controls are an extended feature now, so support is a per-provider
    // declaration rather than a baseline guarantee — Claude reaches it by
    // restarting, Codex natively, and both count as supported.
    for harness in [codex, claude] {
        assert!(harness
            .descriptor()
            .supports(HarnessFeature::SessionControls));
    }
}

#[test]
fn archcar_daemon_guard_stops_its_daemon_when_a_test_panics() {
    let temp = tempfile::tempdir().unwrap();
    let daemon = ArchcarDaemon::start(temp.path(), &[]);
    let endpoint = archcar_endpoint_path(temp.path());
    assert!(archcar_endpoint_accepts(&endpoint));

    let started = Instant::now();
    let failed_test = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _daemon = daemon;
        panic!("simulated failing assertion");
    }));

    assert!(failed_test.is_err());
    assert!(
        started.elapsed() < ARCHCAR_DAEMON_STOP_GRACE + Duration::from_secs(5),
        "stopping the daemon took {:?}",
        started.elapsed()
    );
    assert!(!archcar_endpoint_accepts(&endpoint));
    assert!(
        !endpoint.exists(),
        "socket file {} was not unlinked after a panic killed its daemon",
        endpoint.display()
    );
}

fn app(root: &Path) -> AssertCommand {
    let mut command = AssertCommand::cargo_bin("archductor").unwrap();
    for name in developer_archcar_env() {
        command.env_remove(name);
    }
    command.envs(app_env(root)).env(
        // A CLI that finds no daemon spawns one and abandons it, leaking a
        // `--archcar-serve` process per test run. Point that fallback at a
        // binary that exits at once, so a test that needs the daemon fails
        // loudly unless it starts one through `ArchcarDaemon`.
        "ARCHDUCTOR_ARCHCAR_BIN",
        "/bin/false",
    );
    command
}

/// Set inside a developer's own Archductor session; a test must never reach
/// that session's daemon or bind its remote listener.
fn developer_archcar_env() -> Vec<&'static str> {
    let mut names = vec![remote::LISTEN_ENV, remote::REMOTE_ENV, remote::TOKEN_ENV];
    #[cfg(unix)]
    names.extend([handoff::LOCAL_FD_ENV, handoff::REMOTE_FD_ENV]);
    names
}

fn app_env(root: &Path) -> [(&'static str, PathBuf); 8] {
    [
        ("XDG_CONFIG_HOME", root.join("xdg/config")),
        ("XDG_DATA_HOME", root.join("xdg/data")),
        ("XDG_STATE_HOME", root.join("xdg/state")),
        ("XDG_CACHE_HOME", root.join("xdg/cache")),
        ("XDG_RUNTIME_DIR", root.join("xdg/runtime")),
        // The endpoint's next fallback is `env::temp_dir()`, i.e. `$TMPDIR`.
        ("TMPDIR", root.join("xdg/tmp")),
        ("APPDATA", root.join("xdg/config")),
        ("LOCALAPPDATA", root.join("xdg/data")),
    ]
}

/// The endpoint falls back to `$XDG_RUNTIME_DIR`, then `$TMPDIR`; whichever of
/// them `app_env` stops pinning is inherited from the operator, so a daemon a
/// test starts can land in (or collide with) the operator's own runtime dir.
/// Checked on the array itself, so it fails on any host, whatever its env.
#[test]
fn app_env_pins_xdg_runtime_dir_and_tmpdir_under_the_test_root() {
    let root = Path::new("/archductor-test-root");
    let env = app_env(root);
    for key in ["XDG_RUNTIME_DIR", "TMPDIR"] {
        let (_, value) = env
            .iter()
            .find(|(name, _)| *name == key)
            .unwrap_or_else(|| panic!("app_env no longer pins {key}; tests inherit the host's"));
        assert!(
            value.starts_with(root),
            "app_env pins {key} to {}, outside the test root {}",
            value.display(),
            root.display()
        );
    }
}

/// The archcar daemon a test talks to, owned by the test so it cannot outlive
/// it. Dropping the guard (also while a failed assertion unwinds) stops the
/// exact child this guard spawned; it never looks processes up by name or
/// argv, so no other daemon on the machine can be touched. It then removes
/// the socket file at the endpoint it waited on: under a long test root that
/// endpoint lands in a `/tmp/archductor` shared by every run on the box, and
/// a daemon killed before its own exit cleanup would leave the file there.
struct ArchcarDaemon {
    child: Child,
    endpoint: PathBuf,
}

const ARCHCAR_DAEMON_READY_TIMEOUT: Duration = Duration::from_secs(10);
const ARCHCAR_DAEMON_STOP_GRACE: Duration = Duration::from_secs(5);

impl ArchcarDaemon {
    /// Starts `archductor --archcar-serve` on the test's own state dir, with
    /// the same environment `app(root)` gives the CLI plus `extra_env` (which
    /// providers the daemon launches inherit), and waits until it accepts
    /// connections.
    fn start(root: &Path, extra_env: &[(&str, &Path)]) -> Self {
        // Resolved before the spawn: it runs the CLI, and a panic there must
        // not leave a child no guard owns yet.
        let endpoint = archcar_endpoint_path(root);
        let mut command = Command::new(env!("CARGO_BIN_EXE_archductor"));
        for name in developer_archcar_env() {
            command.env_remove(name);
        }
        let child = command
            .arg("--archcar-serve")
            .envs(app_env(root))
            .envs(extra_env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn archcar daemon");
        // Guard first: a readiness panic below must still stop the child.
        let mut daemon = Self { child, endpoint };
        let deadline = Instant::now() + ARCHCAR_DAEMON_READY_TIMEOUT;
        while !archcar_endpoint_accepts(&daemon.endpoint) {
            if let Some(status) = daemon.child.try_wait().expect("poll archcar daemon") {
                panic!("archcar daemon exited before it was ready: {status}");
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for archcar daemon at {}",
                daemon.endpoint.display()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        daemon
    }

    fn stop_child(&mut self) {
        // Once `try_wait` has reaped the child (here, or in `start` before a
        // readiness panic) its pid may already belong to another process, so
        // signal nothing. While it reports the child still running, only this
        // process can reap it, so the pid stays ours until the signal lands.
        match self.child.try_wait() {
            Ok(None) => {}
            Ok(Some(_)) | Err(_) => return,
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .args(["-TERM", &self.child.id().to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            // Bounded: a daemon stuck in shutdown is killed, never waited on.
            let deadline = Instant::now() + ARCHCAR_DAEMON_STOP_GRACE;
            while Instant::now() < deadline {
                match self.child.try_wait() {
                    Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                    Ok(Some(_)) | Err(_) => return,
                }
            }
        }
        // `Child::kill` is a no-op on a child std has already reaped.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ArchcarDaemon {
    fn drop(&mut self) {
        self.stop_child();
        // Whichever way the child stopped. A daemon that exits cleanly already
        // removed this file; one that was killed, or never got as far as
        // binding, did not. Only ever this guard's own path, so no other
        // daemon's socket (the operator's included) can be touched.
        let _ = std::fs::remove_file(&self.endpoint);
    }
}

/// The endpoint a daemon started with `app_env(root)` binds. Resolved by the
/// CLI under that same environment: under a long root the endpoint falls back
/// to `$XDG_RUNTIME_DIR`/`$TMPDIR`, which this test process does not share.
fn archcar_endpoint_path(root: &Path) -> PathBuf {
    let output = app(root)
        .args(["remote", "status"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    local_daemon_endpoint(&String::from_utf8(output).unwrap())
}

/// Parses the `local daemon (<endpoint>)` line `remote status` prints.
fn local_daemon_endpoint(stdout: &str) -> PathBuf {
    let line = stdout
        .lines()
        .find(|line| line.contains("local daemon ("))
        .unwrap_or_else(|| panic!("no local daemon line in:\n{stdout}"));
    line.split_once('(')
        .and_then(|(_, rest)| rest.rsplit_once(')'))
        .map(|(path, _)| PathBuf::from(path))
        .unwrap()
}

#[cfg(unix)]
fn archcar_endpoint_accepts(endpoint: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(endpoint).is_ok()
}

#[cfg(not(unix))]
fn archcar_endpoint_accepts(endpoint: &Path) -> bool {
    endpoint.exists()
}

fn app_with_home(root: &Path, home: &Path) -> AssertCommand {
    let mut command = app(root);
    command.env("HOME", home).env("USERPROFILE", home);
    command
}

fn app_database_path(root: &Path) -> PathBuf {
    root.join("xdg/data/archductor/archductor.db")
}

fn provider_event(
    thread_id: i64,
    item_id: &str,
    kind: ProviderEventKind,
    phase: ProviderEventPhase,
    subtype: &str,
    title: &str,
    body: &str,
) -> ProviderEventDraft {
    ProviderEventDraft {
        provider: "codex".to_owned(),
        provider_event_id: Some(format!("evt-{item_id}")),
        provider_item_id: Some(item_id.to_owned()),
        provider_thread_id: Some("thread-1".to_owned()),
        provider_turn_id: Some("turn-1".to_owned()),
        parent_provider_item_id: None,
        parent_provider_thread_id: None,
        workspace_id: None,
        chat_thread_id: Some(thread_id),
        process_id: None,
        phase,
        kind,
        provider_subtype: Some(subtype.to_owned()),
        provider_sequence: Some(1),
        occurred_at_ms: 42,
        normalized_payload: json!({"title": title, "body": body}),
        raw_json: json!({"method": subtype, "params": {"body": body}}),
        schema_version: 1,
        adapter_version: "test".to_owned(),
    }
}

fn init_repo(path: PathBuf) -> PathBuf {
    fs::create_dir(&path).unwrap();
    Command::new("git")
        .args(["init", "--initial-branch", "main"])
        .arg(&path)
        .status()
        .unwrap();
    fs::write(path.join("README.md"), "demo\n").unwrap();
    Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["add", "."])
        .status()
        .unwrap();
    Command::new("git")
        .arg("-C")
        .arg(&path)
        .args([
            "-c",
            "user.name=Archductor",
            "-c",
            "user.email=archductor@example.test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "initial",
        ])
        .status()
        .unwrap();
    path
}

fn wait_for_session_log(root: &Path) {
    wait_for_session_log_contains(root, "berlin", "cli-session:berlin:");
}

fn wait_for_session_log_contains(root: &Path, workspace: &str, needle: &str) {
    let log_dir = root.join("xdg/state/archductor/logs").join(workspace);
    for _ in 0..100 {
        if fs::read_dir(&log_dir)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.flatten())
            .any(|entry| {
                fs::read_to_string(entry.path())
                    .map(|contents| contents.contains(needle))
                    .unwrap_or(false)
            })
        {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("timed out waiting for session log in {}", log_dir.display());
}

fn wait_for_file_lines(path: &Path, expected: usize) {
    for _ in 0..100 {
        if fs::read_to_string(path)
            .map(|contents| contents.lines().count() >= expected)
            .unwrap_or(false)
        {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!(
        "timed out waiting for {expected} line(s) in {}",
        path.display()
    );
}

/// [`wait_for_file_lines`] for a daemon built with `test-handoff-delay`:
/// every handoff stalls it, so allow several stalls' worth of time.
fn wait_for_file_lines_through_stalls(path: &Path, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if fs::read_to_string(path)
            .map(|contents| contents.lines().count() >= expected)
            .unwrap_or(false)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!(
        "timed out waiting for {expected} line(s) in {}",
        path.display()
    );
}

/// `repo add` the `demo` repo under `root` and `workspace create berlin` in
/// it, pointing the workspace's provider binary at `provider` through the
/// `.archductor/settings.local.toml` key `settings_key`.
fn create_berlin_workspace(
    app: &dyn Fn() -> AssertCommand,
    root: &Path,
    settings_key: &str,
    provider: &Path,
) {
    let repo_path = root.join("demo");
    let workspace_parent = root.join("workspaces/demo");
    app()
        .args([
            "repo",
            "add",
            repo_path.to_str().unwrap(),
            "--name",
            "demo",
            "--default-branch",
            "main",
            "--workspace-parent",
            workspace_parent.to_str().unwrap(),
        ])
        .assert()
        .success();
    app()
        .args([
            "workspace",
            "create",
            "demo",
            "--name",
            "berlin",
            "--branch",
            "lc/berlin",
            "--base",
            "main",
        ])
        .assert()
        .success();
    fs::write(
        repo_path.join(".archductor/settings.local.toml"),
        format!("{settings_key} = {:?}\n", provider.to_string_lossy()),
    )
    .unwrap();
}

/// Kills `berlin`'s session through the daemon and waits for it to exit.
fn kill_berlin_session(app: &dyn Fn() -> AssertCommand, root: &Path) {
    let store = WorkspaceStore::open(app_database_path(root)).unwrap();
    let session_id = store.list_sessions("berlin").unwrap()[0].id;
    app()
        .args(["archcar", "kill", &session_id.to_string()])
        .assert()
        .success();
    wait_for_session_exit(root, session_id);
}

/// Waits until the chat queue of `workspace`'s session is empty -- the daemon
/// has claimed whatever was queued -- polling the store directly so the probe
/// adds no daemon round trip.
fn wait_for_empty_chat_queue(root: &Path, workspace: &str) {
    let store = WorkspaceStore::open(app_database_path(root)).unwrap();
    let thread_id = store.list_sessions(workspace).unwrap()[0]
        .chat_thread_id
        .expect("the session records its chat thread");
    let deadline = Instant::now() + Duration::from_secs(15);
    while !store.list_queued_chat_inputs(thread_id).unwrap().is_empty() {
        assert!(
            Instant::now() < deadline,
            "the daemon never claimed the queued input"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Subscribes to the daemon's event broadcast over its local socket and
/// returns once the daemon has the subscriber registered. Events arrive as
/// their JSON payloads. Needs a running session: the proof of registration is
/// the `session_started` the daemon replays for it, which it sends under the
/// same lock as it registers the subscriber, and every later broadcast takes
/// that lock too. Returning before that proof would let an event broadcast in
/// between go to every subscriber but this one.
#[cfg(unix)]
fn subscribe_to_archcar_events(root: &Path) -> std::sync::mpsc::Receiver<serde_json::Value> {
    use std::io::{BufRead, BufReader, Write};

    let mut stream = std::os::unix::net::UnixStream::connect(archcar_endpoint_path(root)).unwrap();
    let request = json!({
        "id": "test-subscribe",
        "payload": archductor_core::archcar::protocol::ArchcarRequest::Subscribe,
    });
    writeln!(stream, "{request}").unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            let Ok(line) = line else { break };
            let Ok(mut envelope) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if tx.send(envelope["payload"].take()).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(event) if event["type"] == "session_started" && event["replayed"] == true => {
                return rx;
            }
            Ok(_) => {}
            Err(err) => panic!("the daemon never confirmed the event subscription: {err}"),
        }
    }
}

/// Waits for the daemon to broadcast an event of type `event_type`. The
/// daemon broadcasts a session event only after it has handled it.
#[cfg(unix)]
fn wait_for_archcar_event(events: &std::sync::mpsc::Receiver<serde_json::Value>, event_type: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(remaining) {
            Ok(event) if event["type"] == event_type => return,
            Ok(_) => {}
            Err(err) => panic!("no {event_type} event from the daemon: {err}"),
        }
    }
}

/// Polls `archcar status <session>` until the daemon reports it ready.
fn wait_for_archcar_ready(app: &dyn Fn() -> AssertCommand, session_id: i64) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let output = app()
            .args(["archcar", "status", &session_id.to_string()])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.contains("ready=true") {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "session {session_id} never became ready: {stdout}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Polls `status <workspace> --json` until the first session reports `want`,
/// and returns that report. Any state other than `want` or `pending` fails at
/// once, and so does still reading `pending` after 5s.
fn wait_for_session_state(
    app: &dyn Fn() -> AssertCommand,
    workspace: &str,
    want: &str,
    pending: &str,
) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_millis(5000);
    loop {
        let output = app()
            .args(["status", workspace, "--json"])
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        let status: serde_json::Value = serde_json::from_slice(&output).unwrap();
        let state = &status["workspaces"][0]["sessions"][0]["state"];
        if state == want {
            return status;
        }
        assert_eq!(state, pending, "unexpected session state: {status}");
        assert!(
            Instant::now() < deadline,
            "session never reported {want}, still {pending}: {status}"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn wait_for_running_session(root: &Path, workspace: &str) -> i64 {
    for _ in 0..100 {
        if let Some(session) = WorkspaceStore::open(app_database_path(root))
            .ok()
            .and_then(|store| store.list_sessions(workspace).ok())
            .into_iter()
            .flatten()
            .find(|session| session.status == archductor_core::workspace::ProcessStatus::Running)
        {
            return session.id;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("timed out waiting for running session in workspace {workspace}");
}

fn wait_for_archcar_screen_contains(root: &Path, session_id: i64, needle: &str) {
    for _ in 0..100 {
        let output = app(root)
            .args(["archcar", "screen", &session_id.to_string()])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        if output.status.success() && stdout.contains(needle) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("timed out waiting for session {session_id} screen to contain {needle:?}");
}

fn wait_for_visible_user_messages(
    root: &Path,
    thread_id: i64,
    expected: &[&str],
) -> Vec<archductor_core::workspace::ChatMessageRecord> {
    for _ in 0..100 {
        let visible_messages = WorkspaceStore::open(app_database_path(root))
            .and_then(|store| store.list_chat_messages(thread_id))
            .unwrap_or_default();
        let visible_user_messages = visible_messages
            .iter()
            .filter(|message| message.role == "user")
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>();
        if visible_user_messages == expected {
            return visible_messages;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("timed out waiting for visible user messages {expected:?}");
}

fn wait_for_session_exit(root: &Path, session_id: i64) {
    for _ in 0..300 {
        if WorkspaceStore::open(app_database_path(root))
            .and_then(|store| store.get_process_record(session_id))
            .map(|process| process.status != archductor_core::workspace::ProcessStatus::Running)
            .unwrap_or(false)
        {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("timed out waiting for session {session_id} to exit");
}
