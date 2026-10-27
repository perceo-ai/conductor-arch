//! `archductor remote transfer`: moving a workspace between two daemons.
//!
//! Three real processes, because the thing under test is what happens *between*
//! daemons and a single-daemon test cannot see it. Two `archductor
//! --archcar-serve` daemons run on their own state dirs and own loopback
//! listeners, and a third root stands in for the operator's machine, which
//! holds the two saved clients and runs the command. The operator root points
//! `ARCHDUCTOR_ARCHCAR_BIN` at `/bin/false`, so it has no local daemon at all:
//! anything in the transfer path that still reached for `ArchcarClient::local`
//! would fail here rather than quietly succeed.
//!
//! Both daemons' repositories are clones of one bare repo, which is how the
//! branch actually crosses between them, and both run a fake `codex` instead of
//! a real agent, so no credentials are needed. The fake records its pid and
//! every turn it is handed.
//!
//! Unlike `crates/core/tests/archcar_default_endpoint.rs`, nothing here touches
//! this process's own environment: every daemon and every CLI invocation gets
//! its environment per-child, so these tests are safe at cargo's default
//! parallelism and need no env lock.
#![cfg(unix)]

use archductor_core::archcar::{handoff, remote};
use archductor_core::workspace::{ProcessStatus, WorkspaceStore};
use assert_cmd::Command as AssertCommand;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const DAEMON_READY_TIMEOUT: Duration = Duration::from_secs(20);
const DAEMON_STOP_GRACE: Duration = Duration::from_secs(5);
const POLL_TIMEOUT: Duration = Duration::from_secs(20);

/// Failure this guards: a live session on the source used to be invisible to
/// the copy path, so a takeover would push a branch an agent was still writing.
/// Without `--force` the transfer must refuse, name the session, and leave
/// every side of it untouched — no push, no target workspace, no archive.
#[test]
fn remote_transfer_refuses_a_live_source_session_without_force() {
    let fixture = Fixture::start(TargetSetup::WithClone);

    let refusal = fixture
        .operator(&[
            "remote", "transfer", "berlin", "--from", "src", "--to", "dst",
        ])
        .assert()
        .failure();
    let stderr = String::from_utf8(refusal.get_output().stderr.clone()).unwrap();

    let session = fixture.source_session_id();
    assert!(
        stderr.contains(&format!("session {session} (codex")),
        "the refusal must name the running session; got:\n{stderr}"
    );
    assert!(
        stderr.contains("--force"),
        "the refusal must say how to proceed; got:\n{stderr}"
    );
    assert!(
        stderr.contains("Nothing has been pushed"),
        "the refusal must say the source is untouched; got:\n{stderr}"
    );

    assert!(
        fixture.pushed_commit().is_none(),
        "a refused transfer pushed the branch to the shared remote anyway"
    );
    assert!(
        fixture.target_workspaces().is_empty(),
        "a refused transfer created a workspace on the target"
    );
    assert_eq!(
        fixture.source_workspace().status,
        "active",
        "a refused transfer archived the source workspace"
    );
    assert_eq!(
        fixture.source_session_status(),
        ProcessStatus::Running,
        "a refused transfer stopped the source's session"
    );
}

/// The whole move, end to end, and the orderings that make it safe:
///
/// - the source's session is confirmed gone *before* the branch is pushed. The
///   bare repo's `pre-receive` hook checks the fake provider's pid at the
///   moment of the push and records the answer, so the ordering is observed at
///   the push rather than inferred from timestamps.
/// - the target workspace lands at exactly the commit that was pushed, keeps
///   the source's base ref, and carries the transcript.
/// - a session comes up on the target and is handed the transfer message.
/// - the source is archived, and only once that message had landed.
///
/// Then the same command runs again, which must adopt the workspace already on
/// the target rather than importing a second copy of it.
#[test]
fn remote_transfer_force_stops_the_source_before_pushing_then_resumes_on_the_target() {
    let fixture = Fixture::start(TargetSetup::WithClone);
    let source_session = fixture.source_session_id();

    let transferred = fixture
        .operator(&[
            "remote", "transfer", "berlin", "--from", "src", "--to", "dst", "--force",
        ])
        .assert()
        .success();
    let stdout = String::from_utf8(transferred.get_output().stdout.clone()).unwrap();
    assert!(
        stdout.contains("moved `berlin` from src to dst"),
        "the command should report the move; got:\n{stdout}"
    );

    // Criterion: killed before pushed. The hook ran inside the push and found
    // the provider already gone.
    let events = fs::read_to_string(&fixture.events).unwrap_or_default();
    assert!(
        events.contains("push:provider-gone"),
        "the branch was pushed while the source's provider was still alive; \
         pre-receive saw:\n{events}"
    );
    assert_eq!(
        fixture.source_session_status(),
        ProcessStatus::Exited,
        "session {source_session} on the source was not recorded as exited"
    );

    // Criterion: the target is at the commit that was pushed, with the same
    // base ref and the transcript.
    let pushed = fixture
        .pushed_commit()
        .expect("the source's branch never reached the shared remote");
    let target = fixture.target_workspace("berlin");
    assert_eq!(target.branch, "lc/berlin");
    assert_eq!(
        git_output(&target.path, &["rev-parse", "HEAD"]),
        pushed,
        "the target workspace is not at the commit the source pushed"
    );
    assert_eq!(
        target.base_ref,
        fixture.source_base_ref(),
        "the target workspace did not keep the source's base ref"
    );
    let carried = fixture.target_transcript("berlin");
    assert!(
        carried
            .iter()
            .any(|(role, content)| role == "user" && content.contains(SOURCE_FIRST_MESSAGE)),
        "the source transcript did not land on the target; got {carried:?}"
    );

    // Criterion: a session is up on the target and actually received the
    // transfer message.
    let delivered = wait_for_captured_turns(&fixture.target.capture, 1);
    let first = delivered.first().expect("the target provider took no turn");
    assert!(
        first.starts_with("This conversation moved from daemon src to dst; the branch is at "),
        "the target's provider did not receive the transfer preamble; got:\n{first}"
    );
    // The preamble carries the sha abbreviated, as the daemon reports it, so
    // check it names a prefix of the real commit rather than a fixed width.
    let named_commit = first
        .split("the branch is at ")
        .nth(1)
        .and_then(|rest| rest.split('.').next())
        .expect("the preamble should name a commit");
    assert!(
        named_commit.len() >= 7 && pushed.starts_with(named_commit),
        "the preamble names {named_commit}, not the commit {pushed} the branch landed at"
    );
    assert!(
        first.contains(SOURCE_FIRST_MESSAGE),
        "the transcript's last user message should be replayed; got:\n{first}"
    );

    // Criterion: neither end was this machine. The operator root has no daemon
    // (its `ARCHDUCTOR_ARCHCAR_BIN` is `/bin/false`), so anything that reached
    // for `ArchcarClient::local` would have failed outright — and nothing was
    // written here either way.
    let operator_db = app_database_path(&fixture.operator_root);
    let operator_workspaces = WorkspaceStore::open(&operator_db)
        .map(|store| store.list().unwrap_or_default().len())
        .unwrap_or(0);
    assert_eq!(
        operator_workspaces, 0,
        "the transfer wrote a workspace onto the machine running the command"
    );

    // Criterion: the source is retired, reversibly, and only after the above.
    let source = fixture.source_workspace();
    assert_eq!(source.status, "archived");
    assert!(source.archived_at.is_some());
    assert!(
        source.path.exists(),
        "archiving the source removed its worktree; the move must stay reversible"
    );

    // Criterion: idempotent. The second run finds the branch already on the
    // target and adopts that workspace instead of importing another.
    let again = fixture
        .operator(&[
            "remote", "transfer", "berlin", "--from", "src", "--to", "dst", "--force",
        ])
        .assert()
        .success();
    let rerun = String::from_utf8(again.get_output().stdout.clone()).unwrap();
    assert!(
        rerun.contains("keeping it rather than importing a second copy"),
        "the re-run should say it adopted the existing workspace; got:\n{rerun}"
    );
    assert!(
        rerun.contains("was already handed the conversation"),
        "the re-run should skip the handover, not repeat it; got:\n{rerun}"
    );
    let on_target: Vec<String> = fixture
        .target_workspaces()
        .into_iter()
        .map(|workspace| workspace.name)
        .collect();
    assert_eq!(
        on_target,
        vec!["berlin".to_owned()],
        "re-running the transfer made a second copy on the target"
    );
    // The agent must not be told twice to "continue from where the transcript
    // leaves off": by the second run it has already done that work.
    let turns = fs::read_to_string(&fixture.target.capture).unwrap_or_default();
    assert_eq!(
        turns.lines().count(),
        1,
        "the re-run handed the target's agent another turn:\n{turns}"
    );
}

/// Failure this guards: archiving the source on the way past, before the target
/// had actually taken the work, would lose the operator's only live copy. The
/// target here has no clone of the repository, so the create step fails — and
/// the source workspace has to survive that, with the command saying which step
/// it got to.
#[test]
fn remote_transfer_leaves_the_source_alone_when_the_target_cannot_take_the_workspace() {
    let fixture = Fixture::start(TargetSetup::WithoutClone);

    let failed = fixture
        .operator(&[
            "remote", "transfer", "berlin", "--from", "src", "--to", "dst", "--force",
        ])
        .assert()
        .failure();
    let stderr = String::from_utf8(failed.get_output().stderr.clone()).unwrap();

    assert!(
        stderr.contains("no repository here has remote"),
        "the failure should come from the target's missing clone; got:\n{stderr}"
    );
    assert!(
        stderr.contains("[x] publish") && stderr.contains("[ ] create"),
        "the report should say which step it reached; got:\n{stderr}"
    );
    assert!(
        stderr.contains("Re-run the same command to continue"),
        "the report should say a retry resumes; got:\n{stderr}"
    );

    let source = fixture.source_workspace();
    assert_eq!(
        source.status, "active",
        "the source was archived even though the target never took the workspace"
    );
    assert!(source.archived_at.is_none());
}

/// Finding 1. `--from <saved-alias-of-this-box> --to local` is two address
/// strings and one daemon. The old guard compared the strings the operator
/// typed, so this passed it: the run then adopted the source workspace as its
/// own target (the branch matched), handed it the transfer message, and
/// archived it, leaving a live session inside an archived workspace. The guard
/// now asks each end who it is.
#[test]
fn remote_transfer_refuses_the_same_daemon_reached_under_two_names() {
    let fixture = Fixture::start(TargetSetup::WithClone);
    fixture.save_source_as_its_own_client();

    // `--force` on purpose: the live session must not be what refuses this.
    let refusal = fixture
        .source
        .app()
        .args([
            "remote",
            "transfer",
            "berlin",
            "--from",
            "srcremote",
            "--to",
            "local",
            "--force",
        ])
        .assert()
        .failure();
    let stderr = String::from_utf8(refusal.get_output().stderr.clone()).unwrap();

    assert!(
        stderr.contains("are the same daemon reached two ways"),
        "the same-daemon guard should have fired on identity; got:\n{stderr}"
    );
    let source = fixture.source_workspace();
    assert_eq!(
        source.status, "active",
        "a self-transfer archived the workspace it was moving"
    );
    assert!(
        fixture.pushed_commit().is_none(),
        "a refused self-transfer pushed the branch anyway"
    );
}

/// Finding 2. A live chat with nothing said in it yet: the import seeds no
/// thread (there are no messages to seed), which the old code mistook for a
/// half-finished earlier attempt and refused — after the sessions were killed
/// and the branch pushed, so re-running hit the identical refusal forever. It
/// also made the documented empty-transcript continuation prompt unreachable.
#[test]
fn remote_transfer_gives_an_empty_source_chat_the_continuation_prompt() {
    let fixture = Fixture::start(TargetSetup::WithClone);
    // A chat with nothing said in it. Named explicitly rather than relied on to
    // be the newest: stopping the other chat's session bumps that thread, so
    // "most recently touched" is not stable across the kill.
    let empty = fixture
        .source_store()
        .create_chat_thread("berlin", "codex", "Nothing said yet", None)
        .unwrap();

    let moved = fixture
        .operator(&[
            "remote",
            "transfer",
            "berlin",
            "--from",
            "src",
            "--to",
            "dst",
            "--thread-id",
            &empty.id.to_string(),
            "--force",
        ])
        .assert()
        .success();
    let stdout = String::from_utf8(moved.get_output().stdout.clone()).unwrap();
    assert!(
        stdout.contains("moved `berlin` from src to dst"),
        "the transfer should complete; got:\n{stdout}"
    );

    let delivered = wait_for_captured_turns(&fixture.target.capture, 1);
    let first = delivered.first().expect("the target provider took no turn");
    // `contains`, not `starts_with`: this thread is opened fresh rather than
    // seeded from a transcript, so it is the chat's first turn and the
    // repository's `general` prompt is prepended — the same shape
    // `cli_sessions.rs` pins for any first message.
    assert!(
        first.contains("This conversation moved from daemon src to dst; the branch is at "),
        "an empty chat should still get the transfer preamble; got:\n{first}"
    );
    assert!(
        first.contains("Pick up where you left off"),
        "an empty transcript should get the documented continuation prompt, not a replay; \
         got:\n{first}"
    );
    assert!(
        !first.contains(SOURCE_FIRST_MESSAGE),
        "the other chat's message was replayed into the empty chat; got:\n{first}"
    );
    assert_eq!(
        fixture.source_workspace().status,
        "archived",
        "the source should be retired once the handover landed"
    );
}

/// Finding 3. Branch and workspace names are not identities — two repositories
/// routinely share both. Matching on them alone made the transfer adopt
/// unrelated work: it skipped the import entirely (so neither branch nor
/// transcript moved), handed the message to a stranger's chat, and archived the
/// real source anyway.
#[test]
fn remote_transfer_does_not_adopt_a_same_named_workspace_from_another_repository() {
    let fixture = Fixture::start(TargetSetup::WithDecoyRepository);

    let moved = fixture
        .operator(&[
            "remote", "transfer", "berlin", "--from", "src", "--to", "dst", "--force",
        ])
        .assert()
        .success();
    let stdout = String::from_utf8(moved.get_output().stdout.clone()).unwrap();
    assert!(
        !stdout.contains("keeping it rather than importing a second copy"),
        "the decoy in the other repository was adopted as an earlier attempt; got:\n{stdout}"
    );

    let pushed = fixture
        .pushed_commit()
        .expect("the branch never reached the shared remote");
    let workspaces = fixture.target_workspaces();
    let decoy = workspaces
        .iter()
        .find(|workspace| {
            workspace
                .path
                .to_string_lossy()
                .contains("/workspaces/decoy/")
        })
        .expect("the decoy workspace vanished");
    let imported = workspaces
        .iter()
        .find(|workspace| {
            workspace
                .path
                .to_string_lossy()
                .contains("/workspaces/demo/")
        })
        .expect("the transfer never imported into the right repository");

    assert_eq!(
        git_output(&imported.path, &["rev-parse", "HEAD"]),
        pushed,
        "the imported workspace is not at the commit the source pushed"
    );
    assert_ne!(
        git_output(&decoy.path, &["rev-parse", "HEAD"]),
        pushed,
        "the decoy was moved onto the transferred branch"
    );
    assert!(
        fixture
            .target_store()
            .list_chat_threads(&decoy.name)
            .unwrap()
            .is_empty(),
        "the transfer message was handed to the unrelated workspace's chat"
    );
    assert_eq!(fixture.source_workspace().status, "archived");
}

/// Finding 4. `seed_imported_chat` copies a carried transcript verbatim, so a
/// workspace already moved once arrives carrying the previous hop's transfer
/// preamble. The old "already resumed?" check matched any preamble-shaped user
/// message, so the second hop of a chain was skipped as already done: no
/// session was started on the new target and no message delivered, yet the
/// source was archived anyway.
#[test]
fn remote_transfer_resumes_a_chat_that_already_carries_an_earlier_hops_preamble() {
    let fixture = Fixture::start(TargetSetup::WithClone);
    // Exactly what a previous hop leaves behind: seeded history (source
    // `fork`) whose newest user message is that hop's transfer preamble.
    let store = fixture.source_store();
    let thread = store
        .list_chat_threads("berlin")
        .unwrap()
        .into_iter()
        .next()
        .expect("the source workspace has no chat");
    store
        .append_chat_message(
            thread.id,
            "user",
            "This conversation moved from daemon office to src; the branch is at 1234567. \
             Continue from where the transcript leaves off.",
            "fork",
        )
        .unwrap();

    fixture
        .operator(&[
            "remote", "transfer", "berlin", "--from", "src", "--to", "dst", "--force",
        ])
        .assert()
        .success();

    // The second hop must still start its own session and deliver its own
    // message, rather than reading the carried preamble as a prior resume.
    let delivered = wait_for_captured_turns(&fixture.target.capture, 1);
    let first = delivered.first().unwrap();
    assert!(
        first.starts_with("This conversation moved from daemon src to dst; the branch is at "),
        "hop two did not deliver its own handover; got:\n{first}"
    );
    assert_eq!(
        fixture.source_workspace().status,
        "archived",
        "the source should be archived, but only because the handover really happened"
    );
}

/// Finding 5. An empty queue is not delivery: `claim_next_queued_chat_input` is
/// a `DELETE ... RETURNING`, so the row leaves the queue before the session
/// writes the line and is put back if that write fails. Confirming on queue
/// emptiness let the transfer archive the source for a message no provider ever
/// received. Here the target's agent fails its handshake, so nothing can take
/// the handover.
#[test]
fn remote_transfer_does_not_confirm_delivery_when_the_targets_agent_never_takes_it() {
    let fixture = Fixture::start(TargetSetup::WithFailingProvider);

    let failed = fixture
        .operator(&[
            "remote", "transfer", "berlin", "--from", "src", "--to", "dst", "--force",
        ])
        .assert()
        .failure();
    let stderr = String::from_utf8(failed.get_output().stderr.clone()).unwrap();

    assert!(
        stderr.contains("never delivered") || stderr.contains("had taken it within"),
        "the failure should say the conversation was not delivered; got:\n{stderr}"
    );
    assert!(
        stderr.contains("[ ] resume"),
        "the report should show the resume step unfinished; got:\n{stderr}"
    );
    let source = fixture.source_workspace();
    assert_eq!(
        source.status, "active",
        "the source was archived for a message the target's agent never took"
    );
    assert!(source.archived_at.is_none());
    assert!(
        !fixture.target.capture.exists()
            || fs::read_to_string(&fixture.target.capture)
                .unwrap_or_default()
                .trim()
                .is_empty(),
        "the failing provider somehow took a turn"
    );
}

/// New P1. A transfer that has already landed, re-run after the target's own
/// agent made commits of its own.
///
/// The commit check added for the unrelated-work finding read "not at our sha"
/// as "not this transfer's, import it" — so this imported a *second* workspace
/// onto the same branch and seeded its chat again, starting the target's work
/// twice and putting two worktrees on one branch. Within one repository a
/// branch name is the branch, so the only safe answers are adopt (same commit)
/// or refuse.
#[test]
fn remote_transfer_refuses_to_re_seed_a_target_that_has_moved_on() {
    let fixture = Fixture::start(TargetSetup::WithClone);
    let args = [
        "remote", "transfer", "berlin", "--from", "src", "--to", "dst", "--force",
    ];
    fixture.operator(&args).assert().success();
    wait_for_captured_turns(&fixture.target.capture, 1);

    // The target picks the work up and commits, as the whole point of moving it
    // there was for it to do.
    let moved = fixture.target_workspace("berlin");
    fs::write(moved.path.join("parser2.rs"), "fn parse_more() {}\n").unwrap();
    fixture
        .target
        .app()
        .args(["archcar", "commit", "berlin", "more parsing", "--stage-all"])
        .assert()
        .success();
    let diverged_head = git_output(&moved.path, &["rev-parse", "HEAD"]);

    let refusal = fixture.operator(&args).assert().failure();
    let stderr = String::from_utf8(refusal.get_output().stderr.clone()).unwrap();

    assert!(
        stderr.contains("has its own commits"),
        "the re-run should refuse a target that has moved on; got:\n{stderr}"
    );
    assert!(
        stderr.contains("[ ] create"),
        "the report should show the create step unfinished; got:\n{stderr}"
    );

    // Nothing was duplicated and nothing was started twice.
    let on_target: Vec<String> = fixture
        .target_workspaces()
        .into_iter()
        .map(|workspace| workspace.name)
        .collect();
    assert_eq!(
        on_target,
        vec!["berlin".to_owned()],
        "the re-run imported a second workspace onto the same branch"
    );
    assert_eq!(
        git_output(&moved.path, &["rev-parse", "HEAD"]),
        diverged_head,
        "the target's own commit was disturbed"
    );
    let turns = fs::read_to_string(&fixture.target.capture).unwrap_or_default();
    assert_eq!(
        turns.lines().count(),
        1,
        "the re-run handed the target's agent the conversation a second time:\n{turns}"
    );
}

// --- harness -------------------------------------------------------------

/// The first thing the source's agent was asked, and therefore the transcript's
/// last user message — the one the target has to be handed back.
const SOURCE_FIRST_MESSAGE: &str = "Wire up the parser";

enum TargetSetup {
    /// The ordinary case: the target has a clone of the same repository.
    WithClone,
    /// The target cannot import, so the create step fails.
    WithoutClone,
    /// The target also holds an unrelated repository that happens to have a
    /// workspace of the same name on the same branch.
    WithDecoyRepository,
    /// The target has the clone, but its agent fails its handshake, so no
    /// session there can ever take the handover.
    WithFailingProvider,
}

struct Fixture {
    _temp: tempfile::TempDir,
    bare: PathBuf,
    events: PathBuf,
    operator_root: PathBuf,
    source: Daemon,
    target: Daemon,
}

impl Fixture {
    fn start(target_setup: TargetSetup) -> Self {
        // Not `tempdir()`: a long `TMPDIR` pushes each daemon's socket past the
        // unix path limit and onto the short-path fallback, which is shared
        // across runs on the box.
        let temp = tempfile::Builder::new()
            .prefix("archxfer-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temp.path().to_path_buf();
        let bare = root.join("remote.git");
        let events = root.join("events.log");

        // One bare repo both daemons clone, seeded before the hook is installed
        // so only the transfer's own push is recorded.
        let seed = init_repo(root.join("seed"));
        run_git(
            &root,
            &["init", "--bare", "--initial-branch", "main"],
            &bare,
        );
        git_output(&seed, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git_output(&seed, &["push", "-q", "origin", "main"]);

        let source = Daemon::start("src", root.join("source"));
        let target = Daemon::start("dst", root.join("target"));
        install_pre_receive_hook(&bare, &events, &source.provider_pid);

        let source_repo = clone_repo(&bare, root.join("source-repo"));
        register_repository(&source, "demo", &source_repo);
        if !matches!(target_setup, TargetSetup::WithoutClone) {
            let target_repo = clone_repo(&bare, root.join("target-repo"));
            register_repository(&target, "demo", &target_repo);
            // Each daemon's clone points at that daemon's own fake provider, so
            // the turns the target takes land in the target's capture file and
            // cannot be confused with the source's.
            if matches!(target_setup, TargetSetup::WithFailingProvider) {
                write_fake_failing_codex(&target.fake_codex).unwrap();
            }
            install_fake_provider(&target, &target_repo);
        }
        install_fake_provider(&source, &source_repo);

        // A second repository on the target with a `berlin` workspace on
        // `lc/berlin`: the same branch and the same name as the one being
        // moved, and nothing to do with it.
        if matches!(target_setup, TargetSetup::WithDecoyRepository) {
            let decoy_bare = root.join("decoy.git");
            let decoy_seed = init_repo(root.join("decoy-seed"));
            run_git(
                &root,
                &["init", "--bare", "--initial-branch", "main"],
                &decoy_bare,
            );
            git_output(
                &decoy_seed,
                &["remote", "add", "origin", decoy_bare.to_str().unwrap()],
            );
            git_output(&decoy_seed, &["push", "-q", "origin", "main"]);
            let decoy_repo = clone_repo(&decoy_bare, root.join("decoy-repo"));
            register_repository(&target, "decoy", &decoy_repo);
            install_fake_provider(&target, &decoy_repo);
            target
                .app()
                .args([
                    "workspace",
                    "create",
                    "decoy",
                    "--name",
                    "berlin",
                    "--branch",
                    "lc/berlin",
                    "--base",
                    "main",
                ])
                .assert()
                .success();
        }

        let fixture = Self {
            _temp: temp,
            bare,
            events,
            operator_root: root.join("operator"),
            source,
            target,
        };
        fixture.seed_source_workspace();
        fixture.save_operator_clients();
        fixture
    }

    /// A workspace on the source with a commit of its own and a live codex
    /// session mid-conversation — the state a transfer has to take over.
    fn seed_source_workspace(&self) {
        self.source
            .app()
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

        // Committed, not just written: `publish_source_branch` refuses a dirty
        // worktree, and that refusal is deliberately not under test here.
        let workspace = self.source_workspace();
        fs::write(workspace.path.join("parser.rs"), "fn parse() {}\n").unwrap();
        self.source
            .app()
            .args(["archcar", "commit", "berlin", "add parser", "--stage-all"])
            .assert()
            .success();

        self.source
            .app()
            .args([
                "session",
                "send",
                "berlin",
                "--kind",
                "codex",
                "--timeout-ms",
                "15000",
                SOURCE_FIRST_MESSAGE,
            ])
            .assert()
            .success();
        wait_for_captured_turns(&self.source.capture, 1);
    }

    /// The operator's two saved clients, written through the real
    /// `remote connect` so the verification handshake is exercised too.
    fn save_operator_clients(&self) {
        for daemon in [&self.source, &self.target] {
            self.operator(&[
                "remote",
                "connect",
                &daemon.address,
                "--token",
                &daemon.token,
                "--label",
                daemon.label,
            ])
            .assert()
            .success();
        }
        // Leave no active client, so an omitted `--from`/`--to` could not
        // accidentally stand in for either end.
        self.operator(&["remote", "disconnect"]).assert().success();
    }

    /// Save the source daemon as a saved client *of itself*, so a CLI run
    /// against the source's own state dir can name one daemon two ways:
    /// `srcremote` over its loopback listener, and `local` over its socket.
    fn save_source_as_its_own_client(&self) {
        self.source
            .app()
            .args([
                "remote",
                "connect",
                &self.source.address,
                "--token",
                &self.source.token,
                "--label",
                "srcremote",
            ])
            .assert()
            .success();
        // Leave the source pointed at itself locally, so `--to local` is the
        // local endpoint rather than the client just saved.
        self.source
            .app()
            .args(["remote", "disconnect"])
            .assert()
            .success();
    }

    fn operator(&self, args: &[&str]) -> AssertCommand {
        let mut command = app(&self.operator_root);
        command.env("HOME", self.operator_root.join("home"));
        command.args(args);
        command
    }

    fn source_store(&self) -> WorkspaceStore {
        WorkspaceStore::open(app_database_path(&self.source.root)).unwrap()
    }

    fn target_store(&self) -> WorkspaceStore {
        WorkspaceStore::open(app_database_path(&self.target.root)).unwrap()
    }

    fn source_workspace(&self) -> archductor_core::workspace::Workspace {
        self.source_store()
            .list()
            .unwrap()
            .into_iter()
            .find(|workspace| workspace.name == "berlin")
            .expect("the source workspace vanished")
    }

    fn source_base_ref(&self) -> String {
        self.source_workspace().base_ref
    }

    fn target_workspaces(&self) -> Vec<archductor_core::workspace::Workspace> {
        self.target_store().list().unwrap()
    }

    fn target_workspace(&self, name: &str) -> archductor_core::workspace::Workspace {
        self.target_workspaces()
            .into_iter()
            .find(|workspace| workspace.name == name)
            .unwrap_or_else(|| panic!("no workspace `{name}` on the target"))
    }

    fn target_transcript(&self, workspace: &str) -> Vec<(String, String)> {
        let store = self.target_store();
        let thread = store
            .list_chat_threads(workspace)
            .unwrap()
            .into_iter()
            .next()
            .expect("the target workspace has no chat");
        store
            .list_chat_messages(thread.id)
            .unwrap()
            .into_iter()
            .map(|message| (message.role, message.content))
            .collect()
    }

    fn source_session_id(&self) -> i64 {
        let store = self.source_store();
        let deadline = Instant::now() + POLL_TIMEOUT;
        loop {
            if let Some(session) = store
                .list_sessions("berlin")
                .unwrap_or_default()
                .into_iter()
                .find(|session| session.status == ProcessStatus::Running)
            {
                return session.id;
            }
            assert!(
                Instant::now() < deadline,
                "no running session on the source workspace"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn source_session_status(&self) -> ProcessStatus {
        let store = self.source_store();
        store
            .list_sessions("berlin")
            .unwrap()
            .into_iter()
            .max_by_key(|session| session.id)
            .expect("the source workspace has no session")
            .status
    }

    /// The commit the shared remote holds for the transferred branch, if the
    /// push ever happened.
    fn pushed_commit(&self) -> Option<String> {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.bare)
            .args(["rev-parse", "refs/heads/lc/berlin"])
            .output()
            .unwrap();
        output
            .status
            .success()
            .then(|| String::from_utf8(output.stdout).unwrap().trim().to_owned())
    }
}

/// One `archductor --archcar-serve` process, on its own state dir, reachable
/// both over its local socket (which the test uses to set the daemon up) and
/// over a loopback TCP listener (which the operator's saved client uses).
struct Daemon {
    label: &'static str,
    root: PathBuf,
    address: String,
    token: String,
    fake_codex: PathBuf,
    /// Where the fake provider records the turns it is handed.
    capture: PathBuf,
    /// Where the fake provider records its own pid, so the push hook can ask
    /// whether it is still alive.
    provider_pid: PathBuf,
    child: Child,
    endpoint: PathBuf,
}

impl Daemon {
    fn start(label: &'static str, root: PathBuf) -> Self {
        let home = root.join("home");
        let fake_codex = root.join("fake-codex");
        let capture = root.join("provider-turns.txt");
        let provider_pid = root.join("provider.pid");
        fs::create_dir_all(&home).unwrap();
        write_fake_codex(&fake_codex).unwrap();

        // Pre-written rather than read back: `ensure_token` only generates one
        // when the file is absent, so writing it first makes the token the test
        // hands its saved client a known value.
        let token = format!("transfer-test-token-{label}");
        let state_dir = root.join("xdg/state/archductor");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(state_dir.join("archcar.token"), &token).unwrap();

        let endpoint = archcar_endpoint_path(&root);
        // A loopback port is picked, released, then handed to the daemon, so
        // another process can take it in between. A failed bind makes the
        // daemon exit at startup, which is visible here, so retry rather than
        // fail the test on an unlucky port.
        for attempt in 0..5 {
            let port = free_loopback_port();
            let address = format!("127.0.0.1:{port}");
            let mut command = Command::new(env!("CARGO_BIN_EXE_archductor"));
            for name in developer_archcar_env() {
                command.env_remove(name);
            }
            let child = command
                .arg("--archcar-serve")
                .envs(app_env(&root))
                .env("HOME", &home)
                .env("USERPROFILE", &home)
                .env(remote::LISTEN_ENV, &address)
                .env("ARCHDUCTOR_CAPTURE_PATH", &capture)
                .env("ARCHDUCTOR_TEST_PID_PATH", &provider_pid)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn archcar daemon");
            // Guard first: a readiness failure below must still stop the child.
            let mut daemon = Self {
                label,
                root: root.clone(),
                address,
                token: token.clone(),
                fake_codex: fake_codex.clone(),
                capture: capture.clone(),
                provider_pid: provider_pid.clone(),
                child,
                endpoint: endpoint.clone(),
            };
            if daemon.wait_until_ready() {
                return daemon;
            }
            assert!(attempt < 4, "archcar daemon `{label}` never came up");
        }
        unreachable!("the loop either returns or asserts");
    }

    /// Both listeners, because the test drives the daemon through one and the
    /// operator through the other.
    fn wait_until_ready(&mut self) -> bool {
        let deadline = Instant::now() + DAEMON_READY_TIMEOUT;
        loop {
            if self
                .child
                .try_wait()
                .expect("poll archcar daemon")
                .is_some()
            {
                return false;
            }
            if std::os::unix::net::UnixStream::connect(&self.endpoint).is_ok()
                && std::net::TcpStream::connect(&self.address).is_ok()
            {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// A CLI pointed at this daemon's own state dir, i.e. over its local
    /// socket. Used to set the daemon up, never to run the transfer.
    fn app(&self) -> AssertCommand {
        let mut command = app(&self.root);
        command
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("ARCHDUCTOR_CAPTURE_PATH", &self.capture)
            .env("ARCHDUCTOR_TEST_PID_PATH", &self.provider_pid);
        command
    }

    fn stop_child(&mut self) {
        // Once `try_wait` has reaped the child its pid may belong to another
        // process, so signal nothing after that.
        match self.child.try_wait() {
            Ok(None) => {}
            Ok(Some(_)) | Err(_) => return,
        }
        let _ = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let deadline = Instant::now() + DAEMON_STOP_GRACE;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Ok(Some(_)) | Err(_) => return,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.stop_child();
        // Only ever this guard's own endpoint, so no other daemon's socket
        // (the operator's included) can be touched.
        let _ = fs::remove_file(&self.endpoint);
    }
}

/// Records, at the moment of the push, whether the source's provider is still
/// alive. Both paths are baked in rather than read from the environment: the
/// hook runs under `git receive-pack`, not under the test.
fn install_pre_receive_hook(bare: &Path, events: &Path, provider_pid: &Path) {
    let hook = bare.join("hooks/pre-receive");
    fs::create_dir_all(hook.parent().unwrap()).unwrap();
    fs::write(
        &hook,
        format!(
            "#!/bin/sh\n\
             cat > /dev/null\n\
             pid=$(cat {pid:?} 2>/dev/null)\n\
             if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then\n\
             \techo push:provider-alive >> {events:?}\n\
             else\n\
             \techo push:provider-gone >> {events:?}\n\
             fi\n\
             exit 0\n",
            pid = provider_pid.to_string_lossy(),
            events = events.to_string_lossy(),
        ),
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
}

/// Point a registered clone at this daemon's fake `codex`, so sessions it
/// launches need no agent credentials.
fn install_fake_provider(daemon: &Daemon, repo: &Path) {
    let settings = repo.join(".archductor/settings.local.toml");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(
        &settings,
        format!(
            "codex_executable_path = {:?}\n",
            daemon.fake_codex.to_string_lossy()
        ),
    )
    .unwrap();
}

fn register_repository(daemon: &Daemon, name: &str, repo: &Path) {
    daemon
        .app()
        .args([
            "repo",
            "add",
            repo.to_str().unwrap(),
            "--name",
            name,
            "--default-branch",
            "main",
            "--workspace-parent",
            daemon.root.join("workspaces").join(name).to_str().unwrap(),
        ])
        .assert()
        .success();
}

fn clone_repo(bare: &Path, dest: PathBuf) -> PathBuf {
    let parent = dest.parent().unwrap().to_path_buf();
    fs::create_dir_all(&parent).unwrap();
    let status = Command::new("git")
        .current_dir(&parent)
        .args(["clone", "-q"])
        .arg(bare)
        .arg(&dest)
        .status()
        .unwrap();
    assert!(status.success(), "clone {} failed", bare.display());
    for (key, value) in [
        ("user.name", "Archductor"),
        ("user.email", "archductor@example.test"),
        ("commit.gpgsign", "false"),
    ] {
        git_output(&dest, &["config", key, value]);
    }
    dest
}

fn init_repo(path: PathBuf) -> PathBuf {
    fs::create_dir_all(&path).unwrap();
    run_git(&path, &["init", "--initial-branch", "main"], &path);
    for (key, value) in [
        ("user.name", "Archductor"),
        ("user.email", "archductor@example.test"),
        ("commit.gpgsign", "false"),
    ] {
        git_output(&path, &["config", key, value]);
    }
    fs::write(path.join("README.md"), "demo\n").unwrap();
    git_output(&path, &["add", "."]);
    git_output(&path, &["commit", "-q", "-m", "initial"]);
    path
}

fn run_git(cwd: &Path, args: &[&str], target: &Path) {
    fs::create_dir_all(cwd).unwrap();
    let status = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .arg(target)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} {} failed", target.display());
}

fn git_output(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} in {} failed: {}",
        repo.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn free_loopback_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn app(root: &Path) -> AssertCommand {
    let mut command = AssertCommand::cargo_bin("archductor").unwrap();
    for name in developer_archcar_env() {
        command.env_remove(name);
    }
    command.envs(app_env(root)).env(
        // A CLI that finds no daemon spawns one and abandons it. Pointed at a
        // binary that exits at once, so anything that reaches for a local
        // daemon it was not given fails loudly instead.
        "ARCHDUCTOR_ARCHCAR_BIN",
        "/bin/false",
    );
    command
}

/// Set inside a developer's own Archductor session; a test must never reach
/// that session's daemon or bind its remote listener.
fn developer_archcar_env() -> Vec<&'static str> {
    vec![
        remote::LISTEN_ENV,
        remote::REMOTE_ENV,
        remote::TOKEN_ENV,
        handoff::LOCAL_FD_ENV,
        handoff::REMOTE_FD_ENV,
    ]
}

fn app_env(root: &Path) -> [(&'static str, PathBuf); 8] {
    [
        ("XDG_CONFIG_HOME", root.join("xdg/config")),
        ("XDG_DATA_HOME", root.join("xdg/data")),
        ("XDG_STATE_HOME", root.join("xdg/state")),
        ("XDG_CACHE_HOME", root.join("xdg/cache")),
        ("XDG_RUNTIME_DIR", root.join("xdg/runtime")),
        ("TMPDIR", root.join("xdg/tmp")),
        ("APPDATA", root.join("xdg/config")),
        ("LOCALAPPDATA", root.join("xdg/data")),
    ]
}

fn app_database_path(root: &Path) -> PathBuf {
    root.join("xdg/data/archductor/archductor.db")
}

/// Resolved by the CLI under the same environment the daemon gets: under a long
/// root the endpoint falls back to `$XDG_RUNTIME_DIR`/`$TMPDIR`, which this
/// process does not share.
fn archcar_endpoint_path(root: &Path) -> PathBuf {
    let output = app(root)
        .args(["remote", "status"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let stdout = String::from_utf8(output).unwrap();
    let line = stdout
        .lines()
        .find(|line| line.contains("local daemon ("))
        .unwrap_or_else(|| panic!("no local daemon line in:\n{stdout}"));
    line.split_once('(')
        .and_then(|(_, rest)| rest.rsplit_once(')'))
        .map(|(path, _)| PathBuf::from(path))
        .unwrap()
}

/// The turns a fake provider has been handed, waited for rather than sampled.
fn wait_for_captured_turns(capture: &Path, expected: usize) -> Vec<String> {
    let deadline = Instant::now() + POLL_TIMEOUT;
    loop {
        let turns: Vec<String> = fs::read_to_string(capture)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<String>(line).ok())
            .collect();
        if turns.len() >= expected {
            return turns;
        }
        assert!(
            Instant::now() < deadline,
            "provider at {} took {} turn(s), expected {expected}",
            capture.display(),
            turns.len()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A `codex` stand-in that refuses `initialize`, so its session never becomes
/// ready and nothing it is handed can be delivered. Same shape as
/// `cli_sessions.rs`'s `write_fake_failing_codex`.
fn write_fake_failing_codex(path: &Path) -> std::io::Result<()> {
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

/// The `codex` app-server protocol, just enough of it to hold a session open
/// and record what it is asked. Adapted from `cli_sessions.rs`'s fake, plus a
/// pid file: the push hook needs to know whether this process is still alive.
fn write_fake_codex(path: &Path) -> std::io::Result<()> {
    fs::write(
        path,
        r#"#!/usr/bin/env python3
import json
import os
import sys

pid_path = os.environ.get("ARCHDUCTOR_TEST_PID_PATH")
if pid_path:
    with open(pid_path, "w", encoding="utf-8") as handle:
        handle.write(str(os.getpid()))

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
