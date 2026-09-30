//! What every agent on the board is actually doing, for `archductor status`.
//!
//! The `processes` table is not a liveness signal on its own: a Claude
//! transport restart used to spawn a new process without recording its PID, so
//! a live agent could sit on a dead PID (and a dead one on a live PID), and the
//! status line's "stopped" was the run script's state, never the agent's. The
//! report here asks the daemon, which holds the child process, whether each
//! session is alive, falls back to the PID only when the daemon cannot answer,
//! and reads activity and outcomes from the provider stream itself.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::UNIX_EPOCH;

use anyhow::Result;
use serde::Serialize;

use crate::chat_transcript::{
    build_chat_transcript, current_tool, last_outcome, latest_pr_url, rfc3339_from_ms,
    TranscriptOptions, TranscriptTurn, TurnOutcome,
};
use crate::provider_events::{ProviderEventRecord, ProviderEventStore};
use crate::provider_interactions::ProviderInteractionStore;
use crate::session_state::AgentSessionState;
use crate::workspace::{
    ChatThreadRecord, ProcessRecord, ProcessStatus, WorkspaceStatusLine, WorkspaceStore,
};

/// Version of the `status --json` document. Bump on any breaking change.
pub const STATUS_SCHEMA_VERSION: u32 = 1;

/// Stopped sessions listed per workspace beyond the live ones, newest first.
const STOPPED_SESSIONS_PER_WORKSPACE: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentActivity {
    /// Alive and mid-turn: thinking, streaming, or running a tool.
    Working,
    /// Alive and blocked on a human: a permission prompt, a question, a plan to
    /// approve, or a fresh session that has not been given a task.
    AwaitingInput,
    /// The last turn completed successfully; the agent is idle or has exited.
    Finished,
    /// The last turn ended in an error.
    Failed,
    /// Not running, and the last turn did not finish (killed, interrupted, or
    /// never started).
    Stopped,
}

impl AgentActivity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::AwaitingInput => "awaiting_input",
            Self::Finished => "finished",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    /// Which state a workspace with several agents reports: the one that most
    /// needs an operator.
    fn urgency(self) -> u8 {
        match self {
            Self::AwaitingInput => 4,
            Self::Failed => 3,
            Self::Working => 2,
            Self::Finished => 1,
            Self::Stopped => 0,
        }
    }
}

/// The daemon's view of one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiveProbe {
    pub alive: bool,
    pub runtime_state: Option<AgentSessionState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LivenessSource {
    /// The daemon that owns the child process answered.
    Daemon,
    /// The daemon was unreachable; the recorded PID was checked instead.
    Pid,
}

pub fn derive_activity(
    alive: bool,
    runtime_state: Option<AgentSessionState>,
    pending_interactions: usize,
    last_turn: Option<TurnOutcome>,
) -> AgentActivity {
    let by_outcome = |unfinished| match last_turn {
        Some(TurnOutcome::Success) => AgentActivity::Finished,
        Some(TurnOutcome::Failed) => AgentActivity::Failed,
        _ => unfinished,
    };
    if !alive {
        return by_outcome(AgentActivity::Stopped);
    }
    if pending_interactions > 0 {
        return AgentActivity::AwaitingInput;
    }
    match runtime_state {
        Some(
            AgentSessionState::Starting
            | AgentSessionState::Running
            | AgentSessionState::Streaming
            | AgentSessionState::ToolRunning,
        ) => AgentActivity::Working,
        Some(AgentSessionState::Failed) => AgentActivity::Failed,
        // Only the PID was checked: an open turn means work in progress.
        None if last_turn == Some(TurnOutcome::Running) => AgentActivity::Working,
        _ => by_outcome(AgentActivity::AwaitingInput),
    }
}

pub fn idle_seconds(last_activity_ms: u64, now_ms: u64) -> u64 {
    now_ms.saturating_sub(last_activity_ms) / 1000
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionReport {
    pub session_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<i64>,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub alive: bool,
    pub liveness_source: LivenessSource,
    pub state: AgentActivity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_outcome: Option<TurnOutcome>,
    pub turns: usize,
    pub pending_interactions: usize,
    pub queued_inputs: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PullRequestReport {
    pub number: i64,
    pub state: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checks: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceReport {
    pub workspace: String,
    pub repository: String,
    pub status: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_upstream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<usize>,
    pub additions: usize,
    pub deletions: usize,
    pub open_todos: usize,
    /// The workspace run script, not an agent: `running` or `stopped`.
    pub run_script: String,
    /// The most urgent agent state in the workspace; absent with no agents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<AgentActivity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<PullRequestReport>,
    /// The workspace PR, else the newest PR link an agent produced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    pub sessions: Vec<SessionReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatusReport {
    pub schema_version: u32,
    pub generated_at: String,
    pub workspaces: Vec<WorkspaceReport>,
}

/// Build the board report. `probe` asks the daemon about one session and
/// returns `None` when the daemon cannot answer, in which case the recorded
/// PID is checked.
pub fn collect_status(
    store: &WorkspaceStore,
    db_path: &Path,
    only_workspace: Option<&str>,
    now_ms: u64,
    probe: &mut dyn FnMut(&ProcessRecord) -> Option<LiveProbe>,
) -> Result<StatusReport> {
    let events = ProviderEventStore::new(db_path);
    let interactions = ProviderInteractionStore::new(db_path.to_path_buf());
    let mut workspaces = Vec::new();
    for line in store.list_status()? {
        if only_workspace.is_some_and(|name| name != line.workspace.name) {
            continue;
        }
        let sessions = session_reports(store, &events, &interactions, &line, now_ms, probe)?;
        workspaces.push(workspace_report(line, sessions));
    }
    if let Some(name) = only_workspace {
        anyhow::ensure!(!workspaces.is_empty(), "workspace {name} not found");
    }
    Ok(StatusReport {
        schema_version: STATUS_SCHEMA_VERSION,
        generated_at: rfc3339_from_ms(now_ms),
        workspaces,
    })
}

fn workspace_report(line: WorkspaceStatusLine, sessions: Vec<SessionReport>) -> WorkspaceReport {
    let state = sessions
        .iter()
        .map(|session| session.state)
        .max_by_key(|state| state.urgency());
    let pr = line.pull_request.as_ref().map(|pr| PullRequestReport {
        number: pr.number,
        state: pr.state.clone(),
        url: pr.url.clone(),
        checks: pr.checks_state.clone(),
    });
    let pr_url = pr
        .as_ref()
        .map(|pr| pr.url.clone())
        .or_else(|| sessions.iter().find_map(|s| s.pr_url.clone()));
    let push = line.branch_push_state.as_ref();
    WorkspaceReport {
        workspace: line.workspace.name,
        repository: line.repository_name,
        status: line.workspace.status,
        branch: line.workspace.branch,
        has_upstream: push.map(|p| p.has_upstream),
        ahead: push.filter(|p| p.has_upstream).map(|p| p.ahead),
        behind: push.filter(|p| p.has_upstream).map(|p| p.behind),
        additions: line.diff_additions,
        deletions: line.diff_deletions,
        open_todos: line.open_todos,
        run_script: if line.run_running {
            "running"
        } else {
            "stopped"
        }
        .to_owned(),
        state,
        pr,
        pr_url,
        sessions,
    }
}

fn session_reports(
    store: &WorkspaceStore,
    events: &ProviderEventStore,
    interactions: &ProviderInteractionStore,
    line: &WorkspaceStatusLine,
    now_ms: u64,
    probe: &mut dyn FnMut(&ProcessRecord) -> Option<LiveProbe>,
) -> Result<Vec<SessionReport>> {
    let workspace = &line.workspace;
    let threads = store
        .list_chat_threads(&workspace.name)?
        .into_iter()
        .map(|thread| (thread.id, thread))
        .collect::<BTreeMap<_, _>>();
    // The newest session of each agent chat: older ones were replaced.
    let mut newest = BTreeMap::<i64, ProcessRecord>::new();
    for process in store.list_sessions(&workspace.name)? {
        let Some(thread_id) = process.chat_thread_id else {
            continue;
        };
        if newest
            .get(&thread_id)
            .is_none_or(|kept| kept.id < process.id)
        {
            newest.insert(thread_id, process);
        }
    }

    let mut reports = Vec::new();
    for (thread_id, process) in newest {
        let records = events.list_for_chat_thread(thread_id)?;
        let turns = build_chat_transcript(
            &records,
            &TranscriptOptions {
                workspace_root: Some(&workspace.path),
                include_thinking: false,
                full: false,
            },
        );
        reports.push(session_report(
            store,
            interactions,
            SessionSignals {
                process: &process,
                thread: threads.get(&thread_id),
                records: &records,
                turns: &turns,
            },
            now_ms,
            probe,
        ));
    }

    // Live agents always; the rest only while the workspace is in use, and
    // only the most recent few, so an old workspace does not flood the output.
    let archived = workspace.status == "archived";
    reports.sort_by_key(|report| std::cmp::Reverse(report.session_id));
    let mut stopped = 0;
    reports.retain(|report| {
        if report.alive {
            return true;
        }
        stopped += 1;
        !archived && stopped <= STOPPED_SESSIONS_PER_WORKSPACE
    });
    Ok(reports)
}

/// What one session's report is read from.
pub struct SessionSignals<'a> {
    pub process: &'a ProcessRecord,
    pub thread: Option<&'a ChatThreadRecord>,
    /// The chat thread's provider events, oldest first.
    pub records: &'a [ProviderEventRecord],
    /// The transcript built from `records`.
    pub turns: &'a [TranscriptTurn],
}

pub fn session_report(
    store: &WorkspaceStore,
    interactions: &ProviderInteractionStore,
    signals: SessionSignals<'_>,
    now_ms: u64,
    probe: &mut dyn FnMut(&ProcessRecord) -> Option<LiveProbe>,
) -> SessionReport {
    let SessionSignals {
        process,
        thread,
        records,
        turns,
    } = signals;
    let (alive, runtime_state, source) = match probe(process) {
        Some(live) => (live.alive, live.runtime_state, LivenessSource::Daemon),
        None => (
            process.status == ProcessStatus::Running && crate::platform::process_alive(process.pid),
            None,
            LivenessSource::Pid,
        ),
    };
    let thread_id = process.chat_thread_id;
    let last_activity_ms = records
        .iter()
        .map(|record| record.occurred_at_ms)
        .max()
        .or_else(|| file_modified_ms(&process.log_path));
    let pending_interactions = thread_id
        .and_then(|id| interactions.list(Some(id), true).ok())
        .map_or(0, |pending| pending.len());
    let queued_inputs = thread_id
        .and_then(|id| store.list_queued_chat_inputs(id).ok())
        .map_or(0, |queued| queued.len());
    let outcome = last_outcome(turns);
    let state = derive_activity(alive, runtime_state, pending_interactions, outcome);
    SessionReport {
        session_id: process.id,
        thread_id,
        kind: thread
            .map(|thread| thread.provider.clone())
            .unwrap_or_else(|| "agent".to_owned()),
        title: thread.map(|thread| thread.title.clone()),
        alive,
        liveness_source: source,
        state,
        last_activity: last_activity_ms.map(rfc3339_from_ms),
        idle_seconds: last_activity_ms.map(|ms| idle_seconds(ms, now_ms)),
        current_tool: (state == AgentActivity::Working)
            .then(|| current_tool(turns))
            .flatten(),
        turn_outcome: outcome,
        turns: turns.len(),
        pending_interactions,
        queued_inputs,
        pr_url: latest_pr_url(turns),
    }
}

fn file_modified_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_transcript::tests::{store_claude_records, FINISHED_TURN, MID_TOOL_CALL_TURN};
    use crate::repository::{AddRepository, RepositoryStore};
    use crate::workspace::{CreateWorkspace, SessionKind, SessionLaunch};
    use std::process::Command;

    fn git(repo: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args([
                "-c",
                "user.name=Archductor",
                "-c",
                "user.email=archductor@example.test",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .status()
            .unwrap();
        assert!(status.success());
    }

    /// A workspace whose one Claude chat has a session row pointing at a PID
    /// that no longer exists — what a transport restart left behind — and a
    /// stream that stopped mid tool call.
    fn board_with_a_stale_pid(
        temp: &Path,
    ) -> (WorkspaceStore, std::path::PathBuf, ProcessRecord, u64) {
        let repo = temp.join("demo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--initial-branch", "main"]);
        std::fs::write(repo.join("README.md"), "demo\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "initial"]);
        let db_path = temp.join("state.db");
        RepositoryStore::open(&db_path)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(temp.join("workspaces")),
            })
            .unwrap();
        let store = WorkspaceStore::open_with_logs(&db_path, temp.join("logs")).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        let thread = store
            .create_chat_thread("berlin", "claude", "Run the tests", None)
            .unwrap();
        let mut exited = Command::new("true").spawn().unwrap();
        let dead_pid = exited.id();
        exited.wait().unwrap();
        let process = store
            .record_session_process_for_thread(
                "berlin",
                thread.id,
                &SessionLaunch {
                    kind: SessionKind::CLAUDE,
                    program: "claude".into(),
                    args: vec!["-p".to_owned()],
                    cwd: temp.to_path_buf(),
                    env: Vec::new(),
                    harness_metadata: None,
                    session_resume_id: None,
                },
                dead_pid,
            )
            .unwrap();
        let base_ms = 1_790_757_000_000;
        let native = format!("{FINISHED_TURN}{MID_TOOL_CALL_TURN}");
        let records = store_claude_records(&db_path, Some(thread.id), &native, base_ms);
        let last_ms = records.iter().map(|r| r.occurred_at_ms).max().unwrap();
        (store, db_path, process, last_ms)
    }

    #[test]
    fn a_daemon_owned_session_on_a_stale_pid_reports_alive_and_its_running_tool() {
        let temp = tempfile::tempdir().unwrap();
        let (store, db_path, process, last_ms) = board_with_a_stale_pid(temp.path());
        assert!(!crate::platform::process_alive(process.pid));

        let report = collect_status(&store, &db_path, None, last_ms + 42_000, &mut |_| {
            Some(LiveProbe {
                alive: true,
                runtime_state: Some(AgentSessionState::ToolRunning),
            })
        })
        .unwrap();

        let workspace = &report.workspaces[0];
        assert_eq!(workspace.state, Some(AgentActivity::Working));
        assert_eq!(workspace.run_script, "stopped");
        assert_eq!(
            workspace.pr_url.as_deref(),
            Some("https://github.com/perceo/archductor/pull/150")
        );
        let session = &workspace.sessions[0];
        assert_eq!(session.session_id, process.id);
        assert!(session.alive);
        assert_eq!(session.liveness_source, LivenessSource::Daemon);
        assert_eq!(session.state, AgentActivity::Working);
        assert_eq!(session.idle_seconds, Some(42));
        assert_eq!(
            session.last_activity.as_deref(),
            Some(rfc3339_from_ms(last_ms).as_str())
        );
        assert_eq!(
            session.current_tool.as_deref(),
            Some("Bash: cargo clippy --all-targets")
        );
        assert_eq!(session.turn_outcome, Some(TurnOutcome::Running));
        assert_eq!(session.turns, 2);

        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["schema_version"], 1);
        assert_eq!(json["workspaces"][0]["sessions"][0]["state"], "working");
    }

    #[test]
    fn without_the_daemon_a_dead_pid_mid_turn_is_stopped_not_working() {
        let temp = tempfile::tempdir().unwrap();
        let (store, db_path, _, last_ms) = board_with_a_stale_pid(temp.path());

        let report =
            collect_status(&store, &db_path, Some("berlin"), last_ms, &mut |_| None).unwrap();

        let session = &report.workspaces[0].sessions[0];
        assert!(!session.alive);
        assert_eq!(session.liveness_source, LivenessSource::Pid);
        assert_eq!(session.state, AgentActivity::Stopped);
        assert_eq!(session.current_tool, None);
        assert!(collect_status(&store, &db_path, Some("nope"), last_ms, &mut |_| None).is_err());
    }

    #[test]
    fn a_streaming_session_is_never_reported_as_stopped() {
        for state in [
            AgentSessionState::Starting,
            AgentSessionState::Running,
            AgentSessionState::Streaming,
            AgentSessionState::ToolRunning,
        ] {
            for outcome in [
                None,
                Some(TurnOutcome::Running),
                Some(TurnOutcome::Success),
                Some(TurnOutcome::Failed),
            ] {
                assert_eq!(
                    derive_activity(true, Some(state), 0, outcome),
                    AgentActivity::Working,
                    "{state:?} {outcome:?}"
                );
            }
        }
    }

    #[test]
    fn an_idle_live_session_reports_how_its_last_turn_ended() {
        let idle = Some(AgentSessionState::WaitingForInput);
        assert_eq!(
            derive_activity(true, idle, 0, Some(TurnOutcome::Success)),
            AgentActivity::Finished
        );
        assert_eq!(
            derive_activity(true, idle, 0, Some(TurnOutcome::Failed)),
            AgentActivity::Failed
        );
        // Fresh session with nothing to do yet.
        assert_eq!(
            derive_activity(true, idle, 0, None),
            AgentActivity::AwaitingInput
        );
    }

    #[test]
    fn a_pending_permission_prompt_wins_over_everything_while_alive() {
        assert_eq!(
            derive_activity(true, Some(AgentSessionState::ToolRunning), 1, None),
            AgentActivity::AwaitingInput
        );
    }

    #[test]
    fn a_dead_session_is_finished_failed_or_stopped_by_its_last_turn() {
        assert_eq!(
            derive_activity(false, None, 0, Some(TurnOutcome::Success)),
            AgentActivity::Finished
        );
        assert_eq!(
            derive_activity(false, None, 0, Some(TurnOutcome::Failed)),
            AgentActivity::Failed
        );
        // Died mid-turn: its prompt is no longer waiting on anyone.
        assert_eq!(
            derive_activity(false, None, 1, Some(TurnOutcome::Running)),
            AgentActivity::Stopped
        );
        assert_eq!(
            derive_activity(false, None, 0, None),
            AgentActivity::Stopped
        );
    }

    #[test]
    fn without_the_daemon_an_open_turn_on_a_live_pid_is_working() {
        assert_eq!(
            derive_activity(true, None, 0, Some(TurnOutcome::Running)),
            AgentActivity::Working
        );
        assert_eq!(
            derive_activity(true, None, 0, Some(TurnOutcome::Success)),
            AgentActivity::Finished
        );
    }

    #[test]
    fn idle_seconds_count_from_the_last_stream_event() {
        assert_eq!(idle_seconds(1_000, 62_999), 61);
        // Clock skew never goes negative.
        assert_eq!(idle_seconds(5_000, 1_000), 0);
    }

    #[test]
    fn the_workspace_reports_its_most_urgent_agent() {
        let mut states = [
            AgentActivity::Finished,
            AgentActivity::Working,
            AgentActivity::AwaitingInput,
            AgentActivity::Stopped,
        ];
        states.sort_by_key(|s| std::cmp::Reverse(s.urgency()));
        assert_eq!(states[0], AgentActivity::AwaitingInput);
    }
}
