//! One ranked list of what needs the human across every workspace.
//!
//! Pure derivation: a [`StatusReport`] plus background tasks in, ranked items
//! out. No database, no daemon, no I/O.

use serde::{Deserialize, Serialize};

use crate::agent_status::{AgentActivity, StatusReport, WorkspaceReport};
use crate::background_tasks::{background_task_is_terminal, BackgroundTask};

/// A session idle this long while still working is treated as stalled.
pub const STALL_THRESHOLD_SECONDS: u64 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    AgentAsked,
    SessionFailed,
    TaskFinished,
    ChecksFailed,
    ReviewComments,
    DiffReady,
    Idle,
}

impl AttentionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentAsked => "agent_asked",
            Self::SessionFailed => "session_failed",
            Self::TaskFinished => "task_finished",
            Self::ChecksFailed => "checks_failed",
            Self::ReviewComments => "review_comments",
            Self::DiffReady => "diff_ready",
            Self::Idle => "idle",
        }
    }

    /// Lower ranks need the human sooner.
    fn rank(self) -> u8 {
        match self {
            Self::AgentAsked => 0,
            Self::SessionFailed => 1,
            Self::TaskFinished => 2,
            Self::ChecksFailed => 3,
            Self::ReviewComments => 4,
            Self::DiffReady => 5,
            Self::Idle => 6,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttentionItem {
    pub kind: AttentionKind,
    pub workspace: String,
    pub repository: String,
    pub thread_id: Option<i64>,
    pub session_id: Option<i64>,
    pub headline: String,
    pub detail: Option<String>,
    pub rank: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttentionQueue {
    pub generated_at: String,
    pub items: Vec<AttentionItem>,
}

fn item(
    kind: AttentionKind,
    workspace: &WorkspaceReport,
    session: Option<(i64, Option<i64>)>,
    headline: String,
) -> AttentionItem {
    AttentionItem {
        kind,
        workspace: workspace.workspace.clone(),
        repository: workspace.repository.clone(),
        thread_id: session.and_then(|(_, thread)| thread),
        session_id: session.map(|(id, _)| id),
        headline,
        detail: None,
        rank: kind.rank(),
    }
}

/// Rank everything that wants the human. `generated_at` is carried over from
/// the report so the two timestamps agree.
pub fn derive_attention(
    report: &StatusReport,
    background_tasks: &[BackgroundTask],
) -> AttentionQueue {
    let mut items = Vec::new();
    for workspace in report.workspaces.iter().filter(|w| w.status != "archived") {
        let queued = workspace.sessions.iter().any(|s| s.queued_inputs > 0);
        for session in &workspace.sessions {
            let ids = Some((session.session_id, session.thread_id));
            if session.state == AgentActivity::AwaitingInput || session.pending_interactions > 0 {
                items.push(item(
                    AttentionKind::AgentAsked,
                    workspace,
                    ids,
                    "Agent is waiting on you".to_string(),
                ));
            }
            if session.state == AgentActivity::Failed {
                items.push(item(
                    AttentionKind::SessionFailed,
                    workspace,
                    ids,
                    "Session failed".to_string(),
                ));
            }
            if session.alive
                && session.state == AgentActivity::Finished
                && session.queued_inputs == 0
            {
                items.push(item(
                    AttentionKind::Idle,
                    workspace,
                    ids,
                    "Agent is idle".to_string(),
                ));
            }
        }
        if let Some(pr) = &workspace.pr {
            if pr
                .checks
                .as_deref()
                .is_some_and(|c| c.eq_ignore_ascii_case("failure"))
            {
                items.push(item(
                    AttentionKind::ChecksFailed,
                    workspace,
                    None,
                    format!("Checks failed on PR #{}", pr.number),
                ));
            }
            if pr.state == "open" {
                items.push(item(
                    AttentionKind::ReviewComments,
                    workspace,
                    None,
                    format!("PR #{} is waiting on review", pr.number),
                ));
            }
        }
        if workspace.additions + workspace.deletions > 0
            && workspace.state == Some(AgentActivity::Finished)
            && !queued
        {
            items.push(item(
                AttentionKind::DiffReady,
                workspace,
                None,
                format!(
                    "+{} -{} ready to review",
                    workspace.additions, workspace.deletions
                ),
            ));
        }
    }
    for task in background_tasks
        .iter()
        .filter(|t| background_task_is_terminal(&t.status))
    {
        items.push(AttentionItem {
            kind: AttentionKind::TaskFinished,
            workspace: task
                .workspace_name
                .clone()
                .unwrap_or_else(|| task.repository_name.clone()),
            repository: task.repository_name.clone(),
            thread_id: None,
            session_id: None,
            headline: format!("Background task {}: {}", task.status, task.title),
            detail: task
                .workspace_name
                .is_none()
                .then(|| "No workspace was created for this task".to_string()),
            rank: AttentionKind::TaskFinished.rank(),
        });
    }
    items.sort_by(|a, b| {
        (a.rank, &a.workspace, a.session_id).cmp(&(b.rank, &b.workspace, b.session_id))
    });
    AttentionQueue {
        generated_at: report.generated_at.clone(),
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_status::{LivenessSource, PullRequestReport, SessionReport};

    fn session(id: i64, state: AgentActivity) -> SessionReport {
        SessionReport {
            session_id: id,
            thread_id: Some(id * 10),
            kind: "claude".into(),
            title: None,
            alive: false,
            liveness_source: LivenessSource::Daemon,
            state,
            last_activity: None,
            idle_seconds: None,
            current_tool: None,
            turn_outcome: None,
            turns: 1,
            pending_interactions: 0,
            queued_inputs: 0,
            pr_url: None,
        }
    }

    fn workspace(name: &str, sessions: Vec<SessionReport>) -> WorkspaceReport {
        let state = sessions.iter().map(|s| s.state).max_by_key(|s| match s {
            AgentActivity::AwaitingInput => 4,
            AgentActivity::Failed => 3,
            AgentActivity::Working => 2,
            AgentActivity::Finished => 1,
            AgentActivity::Stopped => 0,
        });
        WorkspaceReport {
            workspace: name.into(),
            repository: "repo".into(),
            status: "active".into(),
            branch: format!("{name}-branch"),
            has_upstream: None,
            ahead: None,
            behind: None,
            additions: 0,
            deletions: 0,
            open_todos: 0,
            run_script: "stopped".into(),
            state,
            pr: None,
            pr_url: None,
            sessions,
        }
    }

    fn report(workspaces: Vec<WorkspaceReport>) -> StatusReport {
        StatusReport {
            schema_version: 1,
            generated_at: "2026-11-19T00:00:00Z".into(),
            workspaces,
        }
    }

    fn pr(state: &str, checks: Option<&str>) -> PullRequestReport {
        PullRequestReport {
            number: 7,
            state: state.into(),
            url: "https://example.test/pr/7".into(),
            checks: checks.map(str::to_string),
        }
    }

    fn task(status: &str) -> BackgroundTask {
        BackgroundTask {
            id: 1,
            repository_name: "repo".into(),
            workspace_name: Some("alpha".into()),
            task_id: None,
            title: "Refactor".into(),
            prompt: "do it".into(),
            provider: "claude".into(),
            status: status.into(),
            run_checks: false,
            open_pr: false,
            draft_pr: false,
            detail: String::new(),
            error: None,
            created_at: "0".into(),
            updated_at: "0".into(),
        }
    }

    fn pairs(queue: &AttentionQueue) -> Vec<(AttentionKind, &str)> {
        queue
            .items
            .iter()
            .map(|i| (i.kind, i.workspace.as_str()))
            .collect()
    }

    #[test]
    fn awaiting_input_outranks_everything_else() {
        let mut finished = workspace("alpha", vec![session(1, AgentActivity::Finished)]);
        finished.additions = 5;
        finished.pr = Some(pr("open", Some("failure")));
        let asked = workspace("zeta", vec![session(2, AgentActivity::AwaitingInput)]);
        let failed = workspace("beta", vec![session(3, AgentActivity::Failed)]);
        let queue = derive_attention(&report(vec![finished, failed, asked]), &[task("ready")]);
        assert_eq!(queue.items[0].kind, AttentionKind::AgentAsked);
        assert_eq!(queue.items[0].rank, 0);
        assert!(queue.items.iter().skip(1).all(|i| i.rank > 0));
        let ranks: Vec<u8> = queue.items.iter().map(|i| i.rank).collect();
        assert!(ranks.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn workspace_without_sessions_contributes_no_items() {
        let queue = derive_attention(&report(vec![workspace("alpha", vec![])]), &[]);
        assert!(queue.items.is_empty());
        assert_eq!(queue.generated_at, "2026-11-19T00:00:00Z");
    }

    #[test]
    fn archived_workspace_contributes_no_items() {
        let mut ws = workspace("alpha", vec![session(1, AgentActivity::AwaitingInput)]);
        ws.status = "archived".into();
        ws.pr = Some(pr("open", Some("failure")));
        let queue = derive_attention(&report(vec![ws]), &[]);
        assert!(queue.items.is_empty());
    }

    #[test]
    fn finished_session_with_changes_is_diff_ready() {
        let mut ws = workspace("alpha", vec![session(1, AgentActivity::Finished)]);
        ws.additions = 3;
        ws.deletions = 1;
        let queue = derive_attention(&report(vec![ws]), &[]);
        assert_eq!(pairs(&queue), vec![(AttentionKind::DiffReady, "alpha")]);
    }

    #[test]
    fn queued_input_suppresses_diff_ready_and_idle() {
        let mut s = session(1, AgentActivity::Finished);
        s.alive = true;
        s.queued_inputs = 1;
        let mut ws = workspace("alpha", vec![s]);
        ws.additions = 3;
        let queue = derive_attention(&report(vec![ws]), &[]);
        assert!(queue.items.is_empty());
    }

    #[test]
    fn equal_rank_orders_by_workspace_then_session_id() {
        let b = workspace("beta", vec![session(1, AgentActivity::AwaitingInput)]);
        let a = workspace(
            "alpha",
            vec![
                session(9, AgentActivity::AwaitingInput),
                session(4, AgentActivity::AwaitingInput),
            ],
        );
        let queue = derive_attention(&report(vec![b, a]), &[]);
        let order: Vec<(&str, Option<i64>)> = queue
            .items
            .iter()
            .map(|i| (i.workspace.as_str(), i.session_id))
            .collect();
        assert_eq!(
            order,
            vec![("alpha", Some(4)), ("alpha", Some(9)), ("beta", Some(1))]
        );
    }

    #[test]
    fn failed_checks_on_open_pr_produce_both_items() {
        let mut ws = workspace("alpha", vec![]);
        ws.pr = Some(pr("open", Some("FAILURE")));
        let queue = derive_attention(&report(vec![ws]), &[]);
        assert_eq!(
            pairs(&queue),
            vec![
                (AttentionKind::ChecksFailed, "alpha"),
                (AttentionKind::ReviewComments, "alpha"),
            ]
        );
    }

    #[test]
    fn terminal_background_task_produces_a_task_finished_item() {
        for status in ["ready", "failed", "cancelled"] {
            let queue = derive_attention(&report(vec![]), &[task(status)]);
            assert_eq!(pairs(&queue), vec![(AttentionKind::TaskFinished, "alpha")]);
            assert!(queue.items[0].headline.contains(status));
        }
    }

    #[test]
    fn active_background_task_produces_no_item() {
        let queue = derive_attention(&report(vec![]), &[task("running")]);
        assert!(queue.items.is_empty());
    }

    #[test]
    fn terminal_task_without_a_workspace_falls_back_to_the_repository() {
        let mut t = task("failed");
        t.workspace_name = None;
        let queue = derive_attention(&report(vec![]), &[t]);
        assert_eq!(pairs(&queue), vec![(AttentionKind::TaskFinished, "repo")]);
        assert!(queue.items[0].detail.is_some());
    }
}
