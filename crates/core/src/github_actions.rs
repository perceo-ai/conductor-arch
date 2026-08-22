//! GitHub Actions workflow runs for a workspace's branch.
//!
//! The Checks panel already covers *locally configured* checks; this is the
//! other half — what CI did with the branch after it was pushed. Both matter
//! and they answer different questions, so this is a separate surface rather
//! than more rows in the same list.
//!
//! Everything goes through `gh` on the daemon's machine, which is where the
//! checkout and the GitHub auth live.

use serde::{Deserialize, Serialize};

/// One workflow run, flattened to what a status list needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRun {
    pub name: String,
    /// `completed`, `in_progress`, `queued`, …
    pub status: String,
    /// `success`, `failure`, `cancelled`, `skipped`, or empty while running.
    pub conclusion: String,
    pub branch: String,
    pub url: String,
    pub started_at: String,
    /// Run number as GitHub displays it.
    pub number: i64,
}

impl WorkflowRun {
    pub fn is_failure(&self) -> bool {
        matches!(
            self.conclusion.as_str(),
            "failure" | "timed_out" | "startup_failure" | "action_required"
        )
    }

    pub fn is_running(&self) -> bool {
        // A queued run has no conclusion yet; treating it as "not running"
        // would show a branch as settled while CI is still deciding.
        matches!(
            self.status.as_str(),
            "in_progress" | "queued" | "requested" | "waiting"
        )
    }

    pub fn is_success(&self) -> bool {
        self.conclusion == "success"
    }
}

/// Roll-up for a branch, so a caller can render one badge without scanning.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowRunSummary {
    pub runs: Vec<WorkflowRun>,
    pub failing: usize,
    pub running: usize,
    pub succeeded: usize,
    /// Set when `gh` could not answer — no auth, no GitHub remote, not installed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<String>,
}

/// Parse `gh run list --json ...` output.
///
/// Unknown fields are ignored and a malformed entry is skipped rather than
/// failing the whole list: `gh` gains fields between versions, and one odd run
/// should not blank the panel.
pub fn parse_workflow_runs(json: &str) -> Vec<WorkflowRun> {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        name: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        conclusion: String,
        #[serde(default, rename = "headBranch")]
        head_branch: String,
        #[serde(default)]
        url: String,
        #[serde(default, rename = "startedAt")]
        started_at: String,
        #[serde(default, rename = "number")]
        number: i64,
    }

    let Ok(raw) = serde_json::from_str::<Vec<Raw>>(json) else {
        return Vec::new();
    };
    raw.into_iter()
        .filter(|run| !run.name.trim().is_empty())
        .map(|run| WorkflowRun {
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            branch: run.head_branch,
            url: run.url,
            started_at: run.started_at,
            number: run.number,
        })
        .collect()
}

pub fn summarize(runs: Vec<WorkflowRun>) -> WorkflowRunSummary {
    let failing = runs.iter().filter(|r| r.is_failure()).count();
    let running = runs.iter().filter(|r| r.is_running()).count();
    let succeeded = runs.iter().filter(|r| r.is_success()).count();
    WorkflowRunSummary {
        runs,
        failing,
        running,
        succeeded,
        unavailable: None,
    }
}

/// The `gh` arguments used to fetch runs for one branch.
pub fn run_list_args(branch: &str, limit: usize) -> Vec<String> {
    vec![
        "run".to_owned(),
        "list".to_owned(),
        "--branch".to_owned(),
        branch.to_owned(),
        "--limit".to_owned(),
        limit.to_string(),
        "--json".to_owned(),
        "name,status,conclusion,headBranch,url,startedAt,number".to_owned(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
      {"name":"CI","status":"completed","conclusion":"success","headBranch":"main","url":"https://x/1","startedAt":"2026-08-20T00:00:00Z","number":12},
      {"name":"Lint","status":"in_progress","conclusion":"","headBranch":"main","url":"https://x/2","startedAt":"2026-08-20T00:01:00Z","number":13},
      {"name":"Deploy","status":"completed","conclusion":"failure","headBranch":"main","url":"https://x/3","startedAt":"2026-08-20T00:02:00Z","number":14}
    ]"#;

    #[test]
    fn runs_parse_into_a_flat_list() {
        let runs = parse_workflow_runs(SAMPLE);
        assert_eq!(runs.len(), 3);
        assert_eq!(runs[0].name, "CI");
        assert_eq!(runs[0].branch, "main");
        assert_eq!(runs[2].number, 14);
    }

    #[test]
    fn the_summary_counts_each_state_once() {
        let summary = summarize(parse_workflow_runs(SAMPLE));
        assert_eq!(summary.succeeded, 1);
        assert_eq!(summary.running, 1);
        assert_eq!(summary.failing, 1);
    }

    #[test]
    fn a_queued_run_counts_as_running_not_as_settled() {
        let queued = r#"[{"name":"CI","status":"queued","conclusion":"","headBranch":"b","url":"u","startedAt":"","number":1}]"#;
        let summary = summarize(parse_workflow_runs(queued));
        assert_eq!(summary.running, 1);
        assert_eq!(summary.succeeded, 0);
        assert_eq!(summary.failing, 0);
    }

    #[test]
    fn failure_covers_the_states_that_need_a_human() {
        for conclusion in ["failure", "timed_out", "startup_failure", "action_required"] {
            let run = WorkflowRun {
                name: "x".into(),
                status: "completed".into(),
                conclusion: conclusion.into(),
                branch: "b".into(),
                url: String::new(),
                started_at: String::new(),
                number: 1,
            };
            assert!(run.is_failure(), "{conclusion} should read as failing");
        }
        // Cancelled and skipped are not failures — they need no action.
        for conclusion in ["cancelled", "skipped", "neutral"] {
            let run = WorkflowRun {
                name: "x".into(),
                status: "completed".into(),
                conclusion: conclusion.into(),
                branch: "b".into(),
                url: String::new(),
                started_at: String::new(),
                number: 1,
            };
            assert!(!run.is_failure(), "{conclusion} should not read as failing");
        }
    }

    #[test]
    fn malformed_output_yields_an_empty_list_rather_than_an_error() {
        assert!(parse_workflow_runs("not json").is_empty());
        assert!(parse_workflow_runs("").is_empty());
        // `gh` adds fields between versions; unknown ones must not break parsing.
        let extra = r#"[{"name":"CI","status":"completed","conclusion":"success","headBranch":"b","url":"u","startedAt":"","number":1,"somethingNew":true}]"#;
        assert_eq!(parse_workflow_runs(extra).len(), 1);
    }

    #[test]
    fn nameless_entries_are_dropped() {
        let nameless = r#"[{"name":"","status":"completed","conclusion":"success","headBranch":"b","url":"u","startedAt":"","number":1}]"#;
        assert!(parse_workflow_runs(nameless).is_empty());
    }

    #[test]
    fn the_gh_arguments_scope_to_one_branch() {
        let args = run_list_args("lc/feature", 5);
        assert!(args.contains(&"--branch".to_owned()));
        assert!(args.contains(&"lc/feature".to_owned()));
        assert!(args.contains(&"5".to_owned()));
        assert!(args.iter().any(|a| a.contains("headBranch")));
    }
}
