//! Archductor as an MCP server.
//!
//! The UX strategy asks for MCP/API/CLI near-parity on the real workflow
//! objects — workspaces, tasks, sessions, prompts, summaries, checks, review,
//! PRs, and background work — and explicitly *not* on presentation state. This
//! module maps that set of primitives onto MCP tools.
//!
//! Transport is stdio JSON-RPC, which is what MCP clients spawn. Every tool
//! call becomes an `ArchcarRequest` against the daemon, so the MCP surface can
//! never drift away from what the CLI and the desktop app do — and pointing
//! `ARCHDUCTOR_ARCHCAR_REMOTE` at another machine makes the same tools drive a
//! daemon somewhere else.

use std::io::{BufRead, Write};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::archcar::client::ArchcarClient;
use crate::archcar::protocol::{ArchcarRequest, ArchcarResponse};

/// MCP protocol revision this server implements.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
pub const SERVER_NAME: &str = "archductor";

/// One MCP tool and the archcar request it turns into.
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema for the tool's arguments.
    pub schema: fn() -> Value,
    /// Whether the tool changes state. Read-only tools stay available when the
    /// server is started with `--read-only`.
    pub mutating: bool,
    pub build: fn(&Value) -> Result<ArchcarRequest>,
}

fn string_arg(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
        .with_context(|| format!("`{key}` is required"))
}

fn optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn i64_arg(args: &Value, key: &str) -> Result<i64> {
    args.get(key)
        .and_then(Value::as_i64)
        .with_context(|| format!("`{key}` is required"))
}

fn bool_arg(args: &Value, key: &str, fallback: bool) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn string_list(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
    })
}

fn workspace_schema() -> Value {
    object(json!({"workspace": {"type": "string"}}), &["workspace"])
}

fn empty_schema() -> Value {
    object(json!({}), &[])
}

/// The tool surface. Workflow objects only — no panel splits, selected tabs, or
/// scroll positions, per the strategy's explicit non-goal.
pub fn tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "list_workspaces",
            description: "List every workspace (branch) with status, agent, change, and PR counts.",
            schema: empty_schema,
            mutating: false,
            build: |_| Ok(ArchcarRequest::ListWorkspaces),
        },
        ToolSpec {
            name: "list_repositories",
            description: "List registered repositories (projects) and their workspace counts.",
            schema: empty_schema,
            mutating: false,
            build: |_| Ok(ArchcarRequest::ListRepositories),
        },
        ToolSpec {
            name: "create_workspace",
            description: "Create a workspace (branch + worktree) in a repository.",
            schema: || {
                object(
                    json!({
                        "repository": {"type": "string"},
                        "name": {"type": "string"},
                        "branch": {"type": "string"},
                        "base_ref": {"type": "string"},
                    }),
                    &["repository", "name", "branch"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::CreateWorkspace {
                    repository: string_arg(args, "repository")?,
                    name: string_arg(args, "name")?,
                    branch: string_arg(args, "branch")?,
                    base_ref: optional_string(args, "base_ref"),
                })
            },
        },
        ToolSpec {
            name: "archive_workspace",
            description: "Archive a workspace, optionally removing its worktree.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "remove_worktree": {"type": "boolean"},
                    }),
                    &["workspace"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::ArchiveWorkspace {
                    workspace: string_arg(args, "workspace")?,
                    remove_worktree: bool_arg(args, "remove_worktree", false),
                })
            },
        },
        ToolSpec {
            name: "list_tasks",
            description: "List the tasks in a workspace: what each agent is meant to be doing.",
            schema: workspace_schema,
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::ListTasks {
                    workspace: string_arg(args, "workspace")?,
                })
            },
        },
        ToolSpec {
            name: "create_task",
            description: "Create a task in a workspace, optionally with the files it should touch.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                        "intended_areas": {"type": "array", "items": {"type": "string"}},
                    }),
                    &["workspace", "title"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::CreateTask {
                    workspace: string_arg(args, "workspace")?,
                    title: string_arg(args, "title")?,
                    body: optional_string(args, "body").unwrap_or_default(),
                    intended_areas: string_list(args, "intended_areas"),
                })
            },
        },
        ToolSpec {
            name: "update_task",
            description:
                "Update a task's status (todo, in_progress, blocked, review, done), title, body, human owner, blocked reason, or review notes.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "task_id": {"type": "integer"},
                        "status": {"type": "string", "enum": ["todo", "in_progress", "blocked", "review", "done"]},
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                        "owner": {"type": "string"},
                        "blocked_reason": {"type": "string"},
                        "review_notes": {"type": "string"},
                    }),
                    &["workspace", "task_id"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::UpdateTask {
                    workspace: string_arg(args, "workspace")?,
                    task_id: i64_arg(args, "task_id")?,
                    update: crate::workspace_intel::TaskUpdate {
                        title: optional_string(args, "title"),
                        body: optional_string(args, "body"),
                        status: optional_string(args, "status"),
                        owner: optional_string(args, "owner").map(Some),
                        blocked_reason: optional_string(args, "blocked_reason").map(Some),
                        review_notes: optional_string(args, "review_notes"),
                        ..Default::default()
                    },
                })
            },
        },
        ToolSpec {
            name: "list_sessions",
            description: "List the agent sessions (chat threads) in a workspace.",
            schema: workspace_schema,
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::ListChatThreads {
                    workspace: string_arg(args, "workspace")?,
                })
            },
        },
        ToolSpec {
            name: "session_contributions",
            description:
                "Per-agent diff contributions: which session touched which files, and whether those changes survive in the branch.",
            schema: workspace_schema,
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::ListSessionContributions {
                    workspace: string_arg(args, "workspace")?,
                })
            },
        },
        ToolSpec {
            name: "session_runs",
            description:
                "The commands, checks, and runs the daemon executed for one agent session — its run history.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "session_id": {"type": "integer"},
                    }),
                    &["workspace", "session_id"],
                )
            },
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::ListSessionRuns {
                    workspace: string_arg(args, "workspace")?,
                    session_id: i64_arg(args, "session_id")?,
                })
            },
        },
        ToolSpec {
            name: "snapshot_diff_contribution",
            description:
                "Persist a durable snapshot of one session's diff contribution: files, patch, commands, plus supplied risks/blockers.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "session_id": {"type": "integer"},
                        "risks": {"type": "array", "items": {"type": "string"}},
                        "blockers": {"type": "array", "items": {"type": "string"}},
                    }),
                    &["workspace", "session_id"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::SnapshotDiffContribution {
                    workspace: string_arg(args, "workspace")?,
                    session_id: i64_arg(args, "session_id")?,
                    risks: string_list(args, "risks"),
                    blockers: string_list(args, "blockers"),
                })
            },
        },
        ToolSpec {
            name: "diff_contributions",
            description: "The stored per-session diff contribution snapshots for a workspace.",
            schema: workspace_schema,
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::ListDiffContributions {
                    workspace: string_arg(args, "workspace")?,
                })
            },
        },
        ToolSpec {
            name: "send_prompt",
            description: "Queue a prompt for an agent session in a workspace.",
            schema: || {
                object(
                    json!({
                        "thread_id": {"type": "integer"},
                        "prompt": {"type": "string"},
                        "session_kind": {"type": "string", "enum": ["codex", "claude", "shell"]},
                    }),
                    &["thread_id", "prompt"],
                )
            },
            mutating: true,
            build: |args| {
                let prompt = string_arg(args, "prompt")?;
                Ok(ArchcarRequest::QueueChatInput {
                    thread_id: i64_arg(args, "thread_id")?,
                    input: prompt.clone(),
                    visible_input: Some(prompt),
                    kind: crate::archcar::protocol::ArchcarInputKind::User,
                    session_kind: match optional_string(args, "session_kind").as_deref() {
                        Some("claude") => crate::workspace::SessionKind::Claude,
                        Some("shell") => crate::workspace::SessionKind::Shell,
                        _ => crate::workspace::SessionKind::Codex,
                    },
                })
            },
        },
        ToolSpec {
            name: "get_summary",
            description: "Read the stored operational summaries for a workspace.",
            schema: workspace_schema,
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::ListSummaries {
                    workspace: string_arg(args, "workspace")?,
                })
            },
        },
        ToolSpec {
            name: "draft_summary",
            description:
                "Draft (without storing) the workspace summary, or a session handoff summary when session_id is given.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "session_id": {"type": "integer"},
                    }),
                    &["workspace"],
                )
            },
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::DraftSummary {
                    workspace: string_arg(args, "workspace")?,
                    session_id: args.get("session_id").and_then(Value::as_i64),
                })
            },
        },
        ToolSpec {
            name: "save_summary",
            description: "Store a summary for a workspace, session, task, review, or handoff scope.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "scope_type": {"type": "string", "enum": ["workspace", "session", "task", "review", "handoff"]},
                        "scope_id": {"type": "integer"},
                        "body_markdown": {"type": "string"},
                    }),
                    &["workspace", "body_markdown"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::SaveSummary {
                    workspace: string_arg(args, "workspace")?,
                    scope_type: optional_string(args, "scope_type")
                        .unwrap_or_else(|| "workspace".to_owned()),
                    scope_id: args.get("scope_id").and_then(Value::as_i64),
                    body_markdown: string_arg(args, "body_markdown")?,
                    source_refs: string_list(args, "source_refs"),
                })
            },
        },
        ToolSpec {
            name: "refresh_summary",
            description:
                "Refresh and store the operational summary for a workspace, session/current chat, or task from branch-local evidence.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "scope_type": {"type": "string", "enum": ["workspace", "session", "current_chat", "task"]},
                        "scope_id": {"type": "integer"},
                    }),
                    &["workspace"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::RefreshSummary {
                    workspace: string_arg(args, "workspace")?,
                    scope_type: optional_string(args, "scope_type")
                        .unwrap_or_else(|| "workspace".to_owned()),
                    scope_id: args.get("scope_id").and_then(Value::as_i64),
                })
            },
        },
        ToolSpec {
            name: "get_context_briefing",
            description:
                "Read the current AI context briefing for a workspace and optional current chat thread: workspace summary, current chat, tasks, next actions.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "thread_id": {"type": "integer"},
                    }),
                    &["workspace"],
                )
            },
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::GetContextBriefing {
                    workspace: string_arg(args, "workspace")?,
                    thread_id: args.get("thread_id").and_then(Value::as_i64),
                })
            },
        },
        ToolSpec {
            name: "sync_chat_tasks",
            description:
                "Create or update native workspace tasks from clear action items in the current chat.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "thread_id": {"type": "integer"},
                    }),
                    &["workspace"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::SyncChatTasks {
                    workspace: string_arg(args, "workspace")?,
                    thread_id: args.get("thread_id").and_then(Value::as_i64),
                })
            },
        },
        ToolSpec {
            name: "add_context",
            description: "Pin a branch-local note or file as context for this workspace.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "body_or_ref": {"type": "string"},
                        "kind": {"type": "string", "enum": ["note", "summary", "context_pack", "file", "memory"]},
                        "pinned": {"type": "boolean"},
                    }),
                    &["workspace", "body_or_ref"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::AddContextAttachment {
                    workspace: string_arg(args, "workspace")?,
                    source: "local".to_owned(),
                    kind: optional_string(args, "kind").unwrap_or_else(|| "note".to_owned()),
                    body_or_ref: string_arg(args, "body_or_ref")?,
                    scope: optional_string(args, "scope").unwrap_or_default(),
                    pinned: bool_arg(args, "pinned", false),
                })
            },
        },
        ToolSpec {
            name: "list_context",
            description: "List the branch-local context attachments for a workspace.",
            schema: workspace_schema,
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::ListContextAttachments {
                    workspace: string_arg(args, "workspace")?,
                })
            },
        },
        ToolSpec {
            name: "get_changes",
            description:
                "List the changed files in a workspace, against the review base by default.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "scope": {"type": "string", "enum": ["all", "uncommitted"]},
                    }),
                    &["workspace"],
                )
            },
            mutating: false,
            build: |args| {
                use crate::archcar::protocol::WorkspaceChangeScope;
                Ok(ArchcarRequest::GetWorkspaceChanges {
                    workspace: string_arg(args, "workspace")?,
                    scope: match optional_string(args, "scope").as_deref() {
                        Some("uncommitted") => WorkspaceChangeScope::Uncommitted,
                        _ => WorkspaceChangeScope::All,
                    },
                })
            },
        },
        ToolSpec {
            name: "get_diff",
            description: "Print the unified diff for a workspace, or for one file in it.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "path": {"type": "string"},
                    }),
                    &["workspace"],
                )
            },
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::GetWorkspaceDiff {
                    workspace: string_arg(args, "workspace")?,
                    path: optional_string(args, "path"),
                })
            },
        },
        ToolSpec {
            name: "list_checks",
            description: "List the repository's configured checks for a workspace.",
            schema: workspace_schema,
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::ListWorkspaceChecks {
                    workspace: string_arg(args, "workspace")?,
                })
            },
        },
        ToolSpec {
            name: "run_check",
            description: "Run one configured check in a workspace by key.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "key": {"type": "string"},
                    }),
                    &["workspace", "key"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::RunWorkspaceCheck {
                    workspace: string_arg(args, "workspace")?,
                    key: string_arg(args, "key")?,
                })
            },
        },
        ToolSpec {
            name: "get_review_status",
            description: "Merge-readiness summary: changes, checks, todos, review comments, PR state.",
            schema: workspace_schema,
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::GetChecksSummary {
                    workspace: string_arg(args, "workspace")?,
                })
            },
        },
        ToolSpec {
            name: "draft_pull_request",
            description:
                "Generate a PR title and body from the workspace summary, tasks, agent contributions, checks, and risks.",
            schema: workspace_schema,
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::GetPullRequestDraft {
                    workspace: string_arg(args, "workspace")?,
                })
            },
        },
        ToolSpec {
            name: "create_pull_request",
            description: "Open a GitHub pull request for a workspace using local gh auth.",
            schema: || {
                object(
                    json!({
                        "workspace": {"type": "string"},
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                        "draft": {"type": "boolean"},
                    }),
                    &["workspace"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::CreatePullRequest {
                    workspace: string_arg(args, "workspace")?,
                    title: optional_string(args, "title"),
                    body: optional_string(args, "body"),
                    draft: bool_arg(args, "draft", true),
                })
            },
        },
        ToolSpec {
            name: "start_background_task",
            description:
                "Create a workspace, run an agent on a prompt in the background, then prepare the review (checks, summary, optional PR).",
            schema: || {
                object(
                    json!({
                        "repository": {"type": "string"},
                        "prompt": {"type": "string"},
                        "title": {"type": "string"},
                        "provider": {"type": "string", "enum": ["codex", "claude"]},
                        "run_checks": {"type": "boolean"},
                        "open_pr": {"type": "boolean"},
                        "draft_pr": {"type": "boolean"},
                        "extra_agents": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "provider": {"type": "string", "enum": ["codex", "claude"]},
                                    "prompt": {"type": "string"},
                                },
                                "required": ["provider"],
                            },
                        },
                    }),
                    &["repository", "prompt"],
                )
            },
            mutating: true,
            build: |args| {
                Ok(ArchcarRequest::StartBackgroundTask {
                    input: crate::background_tasks::StartBackgroundTask {
                        repository: string_arg(args, "repository")?,
                        prompt: string_arg(args, "prompt")?,
                        title: optional_string(args, "title"),
                        workspace_name: optional_string(args, "workspace_name"),
                        branch: optional_string(args, "branch"),
                        base_ref: optional_string(args, "base_ref"),
                        provider: optional_string(args, "provider")
                            .unwrap_or_else(|| "codex".to_owned()),
                        run_checks: bool_arg(args, "run_checks", true),
                        open_pr: bool_arg(args, "open_pr", false),
                        draft_pr: bool_arg(args, "draft_pr", true),
                        extra_agents: args
                            .get("extra_agents")
                            .and_then(|value| value.as_array())
                            .map(|specs| {
                                specs
                                    .iter()
                                    .filter_map(|spec| {
                                        let provider = spec.get("provider")?.as_str()?.to_owned();
                                        Some(crate::background_tasks::BackgroundAgentSpec {
                                            provider,
                                            prompt: spec
                                                .get("prompt")
                                                .and_then(|value| value.as_str())
                                                .map(str::to_owned),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    },
                })
            },
        },
        ToolSpec {
            name: "list_background_tasks",
            description: "List background development tasks and their progress.",
            schema: || object(json!({"active_only": {"type": "boolean"}}), &[]),
            mutating: false,
            build: |args| {
                Ok(ArchcarRequest::ListBackgroundTasks {
                    active_only: bool_arg(args, "active_only", false),
                })
            },
        },
    ]
}

pub fn tool_definitions(read_only: bool) -> Vec<Value> {
    tools()
        .into_iter()
        .filter(|tool| !read_only || !tool.mutating)
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": (tool.schema)(),
            })
        })
        .collect()
}

/// Run one tool by name and return its archcar response as JSON.
pub fn call_tool(
    client: &ArchcarClient,
    name: &str,
    args: &Value,
    read_only: bool,
) -> Result<Value> {
    let tools = tools();
    let tool = tools
        .iter()
        .find(|tool| tool.name == name)
        .with_context(|| format!("unknown tool `{name}`"))?;
    anyhow::ensure!(
        !read_only || !tool.mutating,
        "`{name}` changes state and this server is running read-only"
    );
    let request = (tool.build)(args)?;
    let response = client.send(request)?;
    if let ArchcarResponse::Error { message } = &response {
        anyhow::bail!("{message}");
    }
    Ok(serde_json::to_value(response)?)
}

/// Serve MCP over stdio until the client closes the stream.
pub fn serve_stdio(client: &ArchcarClient, read_only: bool) -> Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut line = String::new();
    let mut reader = stdin.lock();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line.trim().is_empty() {
            continue;
        }
        let Some(response) = handle_message(client, &line, read_only) else {
            // Notifications get no reply, per JSON-RPC.
            continue;
        };
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }
}

/// Handle one JSON-RPC message. Returns `None` for notifications.
pub fn handle_message(client: &ArchcarClient, line: &str, read_only: bool) -> Option<String> {
    let message: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => {
            return Some(error_response(
                Value::Null,
                -32700,
                &format!("parse error: {err}"),
            ));
        }
    };
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    // No id means a notification: act, but stay silent.
    let id = id?;

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")},
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tool_definitions(read_only)})),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(client, &name, &args, read_only) {
                Ok(value) => Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": serde_json::to_string_pretty(&value).unwrap_or_default(),
                    }],
                    "isError": false,
                })),
                // Tool failures are results, not protocol errors: the model
                // should see the message and adjust.
                Err(err) => Ok(json!({
                    "content": [{"type": "text", "text": format!("{err:#}")}],
                    "isError": true,
                })),
            }
        }
        other => Err(format!("unknown method `{other}`")),
    };

    Some(match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string(),
        Err(message) => error_response(id, -32601, &message),
    })
}

fn error_response(id: Value, code: i64, message: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message},
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_has_a_unique_name_and_an_object_schema() {
        let tools = tools();
        let mut names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();
        names.sort_unstable();
        let unique = names.len();
        names.dedup();
        assert_eq!(names.len(), unique, "duplicate tool names");

        for tool in &tools {
            let schema = (tool.schema)();
            assert_eq!(schema["type"], "object", "{} schema", tool.name);
            assert!(!tool.description.is_empty(), "{} description", tool.name);
        }
    }

    #[test]
    fn read_only_mode_hides_mutating_tools() {
        let all = tool_definitions(false);
        let safe = tool_definitions(true);

        assert!(safe.len() < all.len());
        let safe_names: Vec<&str> = safe
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert!(safe_names.contains(&"list_workspaces"));
        assert!(!safe_names.contains(&"create_pull_request"));
        assert!(!safe_names.contains(&"start_background_task"));
    }

    #[test]
    fn tool_arguments_map_onto_archcar_requests() {
        let tools = tools();
        let find = |name: &str| tools.iter().find(|tool| tool.name == name).unwrap();

        let request = (find("create_task").build)(&json!({
            "workspace": "berlin",
            "title": "Wire the Context tab",
            "intended_areas": ["desktop/src", "crates/core"],
        }))
        .unwrap();
        assert_eq!(
            request,
            ArchcarRequest::CreateTask {
                workspace: "berlin".to_owned(),
                title: "Wire the Context tab".to_owned(),
                body: String::new(),
                intended_areas: vec!["desktop/src".to_owned(), "crates/core".to_owned()],
            }
        );

        let request = (find("update_task").build)(&json!({
            "workspace": "berlin",
            "task_id": 3,
            "status": "blocked",
            "blocked_reason": "waiting on gh auth",
        }))
        .unwrap();
        let ArchcarRequest::UpdateTask { update, .. } = request else {
            panic!("expected update_task");
        };
        assert_eq!(update.status.as_deref(), Some("blocked"));
        assert_eq!(
            update.blocked_reason,
            Some(Some("waiting on gh auth".to_owned()))
        );

        // Missing required arguments are rejected before any RPC is sent.
        let err = (find("create_task").build)(&json!({"title": "no workspace"})).unwrap_err();
        assert!(err.to_string().contains("workspace"), "{err}");
    }

    #[test]
    fn mcp_exposes_context_management_tools() {
        let names: Vec<&str> = tools().into_iter().map(|tool| tool.name).collect();

        assert!(names.contains(&"refresh_summary"));
        assert!(names.contains(&"get_context_briefing"));
        assert!(names.contains(&"sync_chat_tasks"));
        assert!(names.contains(&"create_task"));
        assert!(names.contains(&"update_task"));
        assert!(names.contains(&"get_summary"));
        assert!(names.contains(&"save_summary"));

        // The briefing is read-only; refresh mutates stored summaries.
        let read_only: Vec<Value> = tool_definitions(true);
        let read_only_names: Vec<&str> = read_only
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert!(read_only_names.contains(&"get_context_briefing"));
        assert!(!read_only_names.contains(&"refresh_summary"));
    }

    #[test]
    fn refresh_summary_tool_builds_archcar_request() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "refresh_summary")
            .unwrap();
        let req = (tool.build)(&json!({
            "workspace": "berlin",
            "scope_type": "session",
            "scope_id": 7
        }))
        .unwrap();

        assert!(matches!(
            req,
            ArchcarRequest::RefreshSummary { ref workspace, ref scope_type, scope_id: Some(7) }
                if workspace == "berlin" && scope_type == "session"
        ));

        // Scope defaults to the workspace summary.
        let req = (tool.build)(&json!({"workspace": "berlin"})).unwrap();
        assert!(matches!(
            req,
            ArchcarRequest::RefreshSummary { ref scope_type, scope_id: None, .. }
                if scope_type == "workspace"
        ));

        let briefing = tools
            .iter()
            .find(|tool| tool.name == "get_context_briefing")
            .unwrap();
        let req = (briefing.build)(&json!({"workspace": "berlin", "thread_id": 4})).unwrap();
        assert!(matches!(
            req,
            ArchcarRequest::GetContextBriefing { ref workspace, thread_id: Some(4) }
                if workspace == "berlin"
        ));
    }

    #[test]
    fn draft_pr_defaults_and_background_task_defaults_are_conservative() {
        let tools = tools();
        let find = |name: &str| tools.iter().find(|tool| tool.name == name).unwrap();

        let request = (find("create_pull_request").build)(&json!({"workspace": "berlin"})).unwrap();
        let ArchcarRequest::CreatePullRequest { draft, .. } = request else {
            panic!("expected create_pull_request");
        };
        assert!(draft, "PRs should default to draft");

        let request = (find("start_background_task").build)(
            &json!({"repository": "demo", "prompt": "do it"}),
        )
        .unwrap();
        let ArchcarRequest::StartBackgroundTask { input } = request else {
            panic!("expected start_background_task");
        };
        assert!(
            !input.open_pr,
            "background tasks should not open PRs unasked"
        );
        assert!(input.run_checks);
        assert_eq!(input.provider, "codex");
    }

    #[test]
    fn initialize_and_tools_list_answer_without_a_daemon() {
        let client = ArchcarClient::remote("127.0.0.1:1", "unused");

        let initialized = handle_message(
            &client,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
            false,
        )
        .expect("response");
        let value: Value = serde_json::from_str(&initialized).unwrap();
        assert_eq!(value["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(value["result"]["serverInfo"]["name"], SERVER_NAME);

        let listed = handle_message(
            &client,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            false,
        )
        .expect("response");
        let value: Value = serde_json::from_str(&listed).unwrap();
        assert!(value["result"]["tools"].as_array().unwrap().len() > 10);
    }

    #[test]
    fn notifications_get_no_reply_and_unknown_methods_error() {
        let client = ArchcarClient::remote("127.0.0.1:1", "unused");

        assert!(handle_message(
            &client,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            false
        )
        .is_none());

        let response = handle_message(
            &client,
            r#"{"jsonrpc":"2.0","id":7,"method":"resources/list"}"#,
            false,
        )
        .expect("response");
        let value: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(value["error"]["code"], -32601);
    }

    #[test]
    fn a_mutating_tool_is_refused_in_read_only_mode_before_dialing_the_daemon() {
        let client = ArchcarClient::remote("127.0.0.1:1", "unused");

        let err = call_tool(
            &client,
            "create_pull_request",
            &json!({"workspace": "berlin"}),
            true,
        )
        .unwrap_err();

        assert!(err.to_string().contains("read-only"), "{err}");
    }
}
