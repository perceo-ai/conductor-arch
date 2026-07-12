use crate::provider_events::{
    ProviderEventContext, ProviderEventDraft, ProviderEventKind, ProviderEventPhase,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub const CODEX_APP_SERVER_PROVIDER: &str = "codex";
pub const CODEX_APP_SERVER_DEFAULT_EXECUTABLE: &str = "codex";
pub const CODEX_APP_SERVER_DEFAULT_ARGS: &[&str] = &["app-server"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexAppServerTransport {
    StdioJsonl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAppServerLaunch {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, OsString)>,
    pub transport: CodexAppServerTransport,
}

impl Default for CodexAppServerLaunch {
    fn default() -> Self {
        Self {
            executable: CODEX_APP_SERVER_DEFAULT_EXECUTABLE.to_owned(),
            args: CODEX_APP_SERVER_DEFAULT_ARGS
                .iter()
                .map(|arg| (*arg).to_owned())
                .collect(),
            cwd: None,
            env: Vec::new(),
            transport: CodexAppServerTransport::StdioJsonl,
        }
    }
}

#[derive(Debug)]
pub struct CodexAppServerClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_request_id: u64,
}

impl CodexAppServerClient {
    pub fn spawn(launch: &CodexAppServerLaunch) -> Result<Self> {
        let mut command = Command::new(&launch.executable);
        command
            .args(&launch.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(cwd) = &launch.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in &launch.env {
            command.env(key, value);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn {}", launch.executable))?;
        let stdin = child
            .stdin
            .take()
            .context("codex app-server stdin was not piped")?;
        let stdout = child
            .stdout
            .take()
            .context("codex app-server stdout was not piped")?;

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_request_id: 1,
        })
    }

    pub fn initialize(&mut self, params: &CodexAppServerInitializeParams) -> Result<u64> {
        let request_id = self.next_request_id;
        self.next_request_id += 1;
        write_initialize_request_with_id(&mut self.stdin, request_id, params)?;
        write_initialized_notification(&mut self.stdin)?;
        Ok(request_id)
    }

    pub fn send_request(&mut self, method: &str, params: Value) -> Result<u64> {
        let request_id = self.next_request_id;
        self.next_request_id += 1;
        write_jsonl(
            &mut self.stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }),
        )?;
        Ok(request_id)
    }

    pub fn send_notification(&mut self, method: &str, params: Value) -> Result<()> {
        write_jsonl(
            &mut self.stdin,
            &json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            }),
        )
    }

    pub fn read_message(&mut self) -> Result<Option<CodexAppServerMessage>> {
        read_jsonl_message(&mut self.stdout)
    }

    pub fn process_id(&self) -> u32 {
        self.child.id()
    }

    pub fn kill(&mut self) -> Result<()> {
        self.child.kill().context("failed to kill codex app-server")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAppServerInitializeParams {
    pub client_name: String,
    pub client_version: Option<String>,
    pub workspace_root: Option<PathBuf>,
}

pub fn write_initialize_request<W: Write>(
    writer: &mut W,
    params: &CodexAppServerInitializeParams,
) -> Result<u64> {
    write_initialize_request_with_id(writer, 1, params)?;
    Ok(1)
}

fn write_initialize_request_with_id<W: Write>(
    writer: &mut W,
    request_id: u64,
    params: &CodexAppServerInitializeParams,
) -> Result<()> {
    let mut payload = json!({
        "jsonrpc": "2.0",
        "id": request_id,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": params.client_name.clone(),
                },
                "capabilities": {
                    "providerEvents": true,
                    "rawJson": true,
            },
        },
    });

    if let Some(version) = &params.client_version {
        payload["params"]["clientInfo"]["version"] = Value::String(version.clone());
    }
    if let Some(root) = &params.workspace_root {
        payload["params"]["workspaceFolders"] = json!([{
            "uri": file_uri(root),
            "name": root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("workspace"),
        }]);
        payload["params"]["rootUri"] = Value::String(file_uri(root));
    }

    write_jsonl(writer, &payload)
}

pub fn write_initialized_notification<W: Write>(writer: &mut W) -> Result<()> {
    write_jsonl(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "method": "initialized",
        }),
    )
}

fn write_jsonl<W: Write>(writer: &mut W, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, value).context("failed to serialize JSON-RPC message")?;
    writer
        .write_all(b"\n")
        .context("failed to write JSON-RPC newline")?;
    writer.flush().context("failed to flush JSON-RPC writer")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexAppServerMessageKind {
    Notification,
    Request,
    Response,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexAppServerMessage {
    pub raw_json: String,
    pub value: Value,
    pub message_kind: CodexAppServerMessageKind,
    pub method: Option<String>,
    pub id: Option<Value>,
}

impl CodexAppServerMessage {
    pub fn to_provider_event_draft(&self) -> CodexProviderEventDraft {
        let method = self.method.as_deref().unwrap_or("");
        CodexProviderEventDraft {
            provider: CODEX_APP_SERVER_PROVIDER.to_owned(),
            message_kind: self.message_kind,
            category: classify_codex_method(method, self.message_kind),
            name: self
                .method
                .clone()
                .unwrap_or_else(|| match self.message_kind {
                    CodexAppServerMessageKind::Response => "response".to_owned(),
                    CodexAppServerMessageKind::Unknown => "unknown".to_owned(),
                    CodexAppServerMessageKind::Notification
                    | CodexAppServerMessageKind::Request => "unnamed".to_owned(),
                }),
            correlation_id: self.id.as_ref().map(json_rpc_id_to_string),
            raw_json: self.raw_json.clone(),
            payload: self.value.clone(),
        }
    }
}

pub fn read_jsonl_messages<R: BufRead>(mut reader: R) -> Result<Vec<CodexAppServerMessage>> {
    let mut messages = Vec::new();
    let mut line = String::new();
    let mut line_number = 0usize;

    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .context("failed to read codex app-server JSONL")?;
        if bytes == 0 {
            break;
        }
        line_number += 1;
        let raw = line.trim_end_matches(['\r', '\n']).to_owned();
        if raw.trim().is_empty() {
            continue;
        }
        messages.push(parse_jsonl_message(&raw, line_number)?);
    }

    Ok(messages)
}

fn read_jsonl_message<R: BufRead>(reader: &mut R) -> Result<Option<CodexAppServerMessage>> {
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .context("failed to read codex app-server JSONL")?;
        if bytes == 0 {
            return Ok(None);
        }
        let raw = line.trim_end_matches(['\r', '\n']).to_owned();
        if raw.trim().is_empty() {
            continue;
        }
        return parse_jsonl_message(&raw, 1).map(Some);
    }
}

fn parse_jsonl_message(raw: &str, line_number: usize) -> Result<CodexAppServerMessage> {
    let value: Value = serde_json::from_str(raw)
        .with_context(|| format!("invalid codex app-server JSONL at line {line_number}"))?;
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let id = value.get("id").cloned();
    let message_kind = match (method.is_some(), id.is_some()) {
        (true, true) => CodexAppServerMessageKind::Request,
        (true, false) => CodexAppServerMessageKind::Notification,
        (false, true) => CodexAppServerMessageKind::Response,
        (false, false) => CodexAppServerMessageKind::Unknown,
    };

    Ok(CodexAppServerMessage {
        raw_json: raw.to_owned(),
        value,
        message_kind,
        method,
        id,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexProviderEventCategory {
    AccountAuth,
    ThreadSessionLifecycle,
    GoalsTasks,
    Turns,
    UserInput,
    AssistantOutput,
    PlanningReasoning,
    CommandProcessExecution,
    TerminalBackgroundRuntime,
    Filesystem,
    DiffsFileChanges,
    Tools,
    Mcp,
    SkillsPluginsHooks,
    ApprovalsPermissions,
    SubagentsCollaboration,
    WebBrowserMedia,
    EnvironmentConfigModel,
    LimitsFailures,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexCapabilityCoverage {
    pub category: CodexProviderEventCategory,
    pub label: &'static str,
}

pub const CODEX_APP_SERVER_CAPABILITY_COVERAGE: &[CodexCapabilityCoverage] = &[
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::AccountAuth,
        label: "account/auth",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::ThreadSessionLifecycle,
        label: "thread/session lifecycle",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::GoalsTasks,
        label: "goals/tasks",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::Turns,
        label: "turns",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::UserInput,
        label: "user input",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::AssistantOutput,
        label: "assistant output",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::PlanningReasoning,
        label: "planning/reasoning",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::CommandProcessExecution,
        label: "command/process execution",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::TerminalBackgroundRuntime,
        label: "terminal/background runtime",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::Filesystem,
        label: "filesystem",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::DiffsFileChanges,
        label: "diffs/file changes",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::Tools,
        label: "tools",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::Mcp,
        label: "MCP",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::SkillsPluginsHooks,
        label: "skills/plugins/hooks",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::ApprovalsPermissions,
        label: "approvals/permissions",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::SubagentsCollaboration,
        label: "subagents/collaboration",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::WebBrowserMedia,
        label: "web/browser/media",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::EnvironmentConfigModel,
        label: "environment/config/model",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::LimitsFailures,
        label: "limits/failures",
    },
    CodexCapabilityCoverage {
        category: CodexProviderEventCategory::Unknown,
        label: "unknown events",
    },
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexProviderEventDraft {
    pub provider: String,
    pub message_kind: CodexAppServerMessageKind,
    pub category: CodexProviderEventCategory,
    pub name: String,
    pub correlation_id: Option<String>,
    pub raw_json: String,
    pub payload: Value,
}

impl CodexProviderEventDraft {
    pub fn into_provider_event_draft(self, context: ProviderEventContext) -> ProviderEventDraft {
        let raw_json = serde_json::from_str(&self.raw_json)
            .unwrap_or_else(|_| Value::String(self.raw_json.clone()));
        let kind = codex_category_to_provider_kind(self.category);
        let phase = codex_phase_for(&self.name, self.message_kind);
        let provider_event_id = self.correlation_id.clone().or_else(|| {
            string_at_any(
                &self.payload,
                &[
                    "/params/event/id",
                    "/params/eventId",
                    "/params/event_id",
                    "/params/id",
                    "/result/id",
                ],
            )
        });
        let provider_item_id = string_at_any(
            &self.payload,
            &[
                "/params/item/id",
                "/params/itemId",
                "/params/item_id",
                "/params/message/id",
                "/params/toolCall/id",
                "/params/tool_call/id",
                "/result/item/id",
                "/result/message/id",
            ],
        );
        let provider_thread_id = string_at_any(
            &self.payload,
            &[
                "/params/thread/id",
                "/params/threadId",
                "/params/thread_id",
                "/params/session/id",
                "/params/sessionId",
                "/params/session_id",
                "/result/threadId",
                "/result/thread_id",
            ],
        );
        let provider_turn_id = string_at_any(
            &self.payload,
            &[
                "/params/turn/id",
                "/params/turnId",
                "/params/turn_id",
                "/result/turnId",
                "/result/turn_id",
            ],
        );
        let parent_provider_item_id = string_at_any(
            &self.payload,
            &[
                "/params/parent/id",
                "/params/parentItemId",
                "/params/parent_item_id",
                "/params/parent/item_id",
            ],
        );
        let parent_provider_thread_id = string_at_any(
            &self.payload,
            &[
                "/params/parentThreadId",
                "/params/parent_thread_id",
                "/params/parent/thread_id",
            ],
        );
        let body = string_at_any(
            &self.payload,
            &[
                "/params/text",
                "/params/delta",
                "/params/message/text",
                "/params/message/content",
                "/result/text",
                "/result/message",
            ],
        )
        .unwrap_or_default();

        ProviderEventDraft {
            provider: self.provider,
            provider_event_id,
            provider_item_id,
            provider_thread_id,
            provider_turn_id,
            parent_provider_item_id,
            parent_provider_thread_id,
            workspace_id: context.workspace_id,
            chat_thread_id: context.chat_thread_id,
            process_id: context.process_id,
            phase,
            kind,
            provider_subtype: Some(self.name.clone()),
            provider_sequence: number_at_any(
                &self.payload,
                &[
                    "/params/sequence",
                    "/params/seq",
                    "/result/sequence",
                    "/result/seq",
                ],
            )
            .and_then(|value| i64::try_from(value).ok()),
            occurred_at_ms: context.occurred_at_ms,
            normalized_payload: json!({
                "title": self.name,
                "body": body,
                "message_kind": self.message_kind,
            }),
            raw_json,
            schema_version: context.schema_version,
            adapter_version: context.adapter_version,
        }
    }
}

pub fn classify_codex_method(
    method: &str,
    message_kind: CodexAppServerMessageKind,
) -> CodexProviderEventCategory {
    if method.is_empty() {
        return match message_kind {
            CodexAppServerMessageKind::Response => CodexProviderEventCategory::Turns,
            CodexAppServerMessageKind::Unknown
            | CodexAppServerMessageKind::Notification
            | CodexAppServerMessageKind::Request => CodexProviderEventCategory::Unknown,
        };
    }

    let normalized = method.to_ascii_lowercase();
    let tokens: Vec<_> = normalized
        .split(|ch: char| !(ch.is_ascii_alphanumeric()))
        .filter(|token| !token.is_empty())
        .collect();

    if has_any(
        &tokens,
        &["auth", "account", "login", "logout", "signin", "userinfo"],
    ) {
        CodexProviderEventCategory::AccountAuth
    } else if has_any(
        &tokens,
        &[
            "thread",
            "session",
            "conversation",
            "resume",
            "initialize",
            "initialized",
        ],
    ) {
        CodexProviderEventCategory::ThreadSessionLifecycle
    } else if has_any(
        &tokens,
        &["goal", "goals", "task", "tasks", "todo", "todos"],
    ) {
        CodexProviderEventCategory::GoalsTasks
    } else if has_any(&tokens, &["turn", "turns"]) {
        CodexProviderEventCategory::Turns
    } else if has_any(&tokens, &["user", "input", "prompt", "composer"]) {
        CodexProviderEventCategory::UserInput
    } else if has_any(
        &tokens,
        &["assistant", "answer", "message", "output", "response"],
    ) {
        CodexProviderEventCategory::AssistantOutput
    } else if has_any(
        &tokens,
        &["plan", "planning", "reasoning", "thought", "analysis"],
    ) {
        CodexProviderEventCategory::PlanningReasoning
    } else if has_any(
        &tokens,
        &["command", "exec", "execution", "process", "subprocess"],
    ) {
        CodexProviderEventCategory::CommandProcessExecution
    } else if has_any(
        &tokens,
        &["terminal", "background", "runtime", "shell", "pty"],
    ) {
        CodexProviderEventCategory::TerminalBackgroundRuntime
    } else if has_any(
        &tokens,
        &["diff", "patch", "change", "changes", "edit", "edited"],
    ) {
        CodexProviderEventCategory::DiffsFileChanges
    } else if has_any(
        &tokens,
        &["file", "files", "filesystem", "fs", "directory", "path"],
    ) {
        CodexProviderEventCategory::Filesystem
    } else if has_any(&tokens, &["tool", "tools", "toolcall"]) {
        CodexProviderEventCategory::Tools
    } else if has_any(&tokens, &["mcp"]) {
        CodexProviderEventCategory::Mcp
    } else if has_any(
        &tokens,
        &["skill", "skills", "plugin", "plugins", "hook", "hooks"],
    ) {
        CodexProviderEventCategory::SkillsPluginsHooks
    } else if has_any(
        &tokens,
        &[
            "approval",
            "approvals",
            "permission",
            "permissions",
            "sandbox",
            "policy",
        ],
    ) {
        CodexProviderEventCategory::ApprovalsPermissions
    } else if has_any(
        &tokens,
        &[
            "subagent",
            "subagents",
            "collaboration",
            "delegate",
            "worker",
        ],
    ) {
        CodexProviderEventCategory::SubagentsCollaboration
    } else if has_any(&tokens, &["web", "browser", "media", "image", "screenshot"]) {
        CodexProviderEventCategory::WebBrowserMedia
    } else if has_any(
        &tokens,
        &["environment", "env", "config", "model", "settings"],
    ) {
        CodexProviderEventCategory::EnvironmentConfigModel
    } else if has_any(
        &tokens,
        &[
            "limit",
            "limits",
            "failure",
            "failures",
            "error",
            "cancel",
            "cancelled",
        ],
    ) {
        CodexProviderEventCategory::LimitsFailures
    } else {
        CodexProviderEventCategory::Unknown
    }
}

fn has_any(tokens: &[&str], needles: &[&str]) -> bool {
    needles.iter().any(|needle| tokens.contains(needle))
}

fn codex_category_to_provider_kind(category: CodexProviderEventCategory) -> ProviderEventKind {
    match category {
        CodexProviderEventCategory::AccountAuth => ProviderEventKind::AccountAuth,
        CodexProviderEventCategory::ThreadSessionLifecycle => ProviderEventKind::ThreadSession,
        CodexProviderEventCategory::GoalsTasks => ProviderEventKind::GoalTask,
        CodexProviderEventCategory::Turns => ProviderEventKind::Turn,
        CodexProviderEventCategory::UserInput => ProviderEventKind::UserInput,
        CodexProviderEventCategory::AssistantOutput => ProviderEventKind::AssistantOutput,
        CodexProviderEventCategory::PlanningReasoning => ProviderEventKind::PlanningReasoning,
        CodexProviderEventCategory::CommandProcessExecution => ProviderEventKind::CommandProcess,
        CodexProviderEventCategory::TerminalBackgroundRuntime => ProviderEventKind::TerminalRuntime,
        CodexProviderEventCategory::Filesystem => ProviderEventKind::FileSystem,
        CodexProviderEventCategory::DiffsFileChanges => ProviderEventKind::DiffFileChange,
        CodexProviderEventCategory::Tools => ProviderEventKind::Tool,
        CodexProviderEventCategory::Mcp => ProviderEventKind::Mcp,
        CodexProviderEventCategory::SkillsPluginsHooks => ProviderEventKind::SkillPluginHook,
        CodexProviderEventCategory::ApprovalsPermissions => ProviderEventKind::ApprovalPermission,
        CodexProviderEventCategory::SubagentsCollaboration => {
            ProviderEventKind::SubagentCollaboration
        }
        CodexProviderEventCategory::WebBrowserMedia => ProviderEventKind::WebBrowserMedia,
        CodexProviderEventCategory::EnvironmentConfigModel => {
            ProviderEventKind::EnvironmentConfigModel
        }
        CodexProviderEventCategory::LimitsFailures => ProviderEventKind::LimitFailure,
        CodexProviderEventCategory::Unknown => ProviderEventKind::Unknown,
    }
}

fn codex_phase_for(name: &str, message_kind: CodexAppServerMessageKind) -> ProviderEventPhase {
    let normalized = name.to_ascii_lowercase();
    let tokens: Vec<_> = normalized
        .split(|ch: char| !(ch.is_ascii_alphanumeric()))
        .filter(|token| !token.is_empty())
        .collect();

    if has_any(&tokens, &["error", "failed", "failure"]) {
        ProviderEventPhase::Failed
    } else if has_any(&tokens, &["declined", "denied", "rejected"]) {
        ProviderEventPhase::Declined
    } else if has_any(
        &tokens,
        &["interrupt", "interrupted", "cancel", "cancelled"],
    ) {
        ProviderEventPhase::Interrupted
    } else if has_any(&tokens, &["delta", "partial", "chunk"]) {
        ProviderEventPhase::Delta
    } else if has_any(&tokens, &["progress", "running", "stdout", "stderr"]) {
        ProviderEventPhase::Progress
    } else if has_any(
        &tokens,
        &[
            "completed",
            "complete",
            "done",
            "finished",
            "finish",
            "stop",
            "stopped",
            "closed",
            "result",
        ],
    ) || message_kind == CodexAppServerMessageKind::Response
    {
        ProviderEventPhase::Completed
    } else if has_any(
        &tokens,
        &["started", "start", "begin", "opened", "created", "request"],
    ) || message_kind == CodexAppServerMessageKind::Request
    {
        ProviderEventPhase::Started
    } else {
        ProviderEventPhase::Unknown
    }
}

fn string_at_any(value: &Value, pointers: &[&str]) -> Option<String> {
    pointers.iter().find_map(|pointer| {
        value.pointer(pointer).and_then(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .or_else(|| value.as_i64().map(|number| number.to_string()))
                .or_else(|| value.as_u64().map(|number| number.to_string()))
        })
    })
}

fn number_at_any(value: &Value, pointers: &[&str]) -> Option<u64> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_u64))
}

fn json_rpc_id_to_string(id: &Value) -> String {
    match id {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        other => other.to_string(),
    }
}

fn file_uri(path: &Path) -> String {
    format!("file://{}", path.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    use std::path::Path;

    #[test]
    fn capability_coverage_names_all_required_codex_categories() {
        let categories: Vec<_> = CODEX_APP_SERVER_CAPABILITY_COVERAGE
            .iter()
            .map(|coverage| coverage.category)
            .collect();

        assert_eq!(
            categories,
            vec![
                CodexProviderEventCategory::AccountAuth,
                CodexProviderEventCategory::ThreadSessionLifecycle,
                CodexProviderEventCategory::GoalsTasks,
                CodexProviderEventCategory::Turns,
                CodexProviderEventCategory::UserInput,
                CodexProviderEventCategory::AssistantOutput,
                CodexProviderEventCategory::PlanningReasoning,
                CodexProviderEventCategory::CommandProcessExecution,
                CodexProviderEventCategory::TerminalBackgroundRuntime,
                CodexProviderEventCategory::Filesystem,
                CodexProviderEventCategory::DiffsFileChanges,
                CodexProviderEventCategory::Tools,
                CodexProviderEventCategory::Mcp,
                CodexProviderEventCategory::SkillsPluginsHooks,
                CodexProviderEventCategory::ApprovalsPermissions,
                CodexProviderEventCategory::SubagentsCollaboration,
                CodexProviderEventCategory::WebBrowserMedia,
                CodexProviderEventCategory::EnvironmentConfigModel,
                CodexProviderEventCategory::LimitsFailures,
                CodexProviderEventCategory::Unknown,
            ]
        );
    }

    #[test]
    fn json_rpc_initialize_and_initialized_are_written_as_jsonl() {
        let mut output = Vec::new();
        let request_id = write_initialize_request(
            &mut output,
            &CodexAppServerInitializeParams {
                client_name: "archductor-test".to_owned(),
                client_version: Some("0.1.0".to_owned()),
                workspace_root: Some(Path::new("/tmp/workspace").to_path_buf()),
            },
        )
        .unwrap();
        write_initialized_notification(&mut output).unwrap();

        assert_eq!(request_id, 1);
        let lines: Vec<_> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect();

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["jsonrpc"], "2.0");
        assert_eq!(lines[0]["id"], 1);
        assert_eq!(lines[0]["method"], "initialize");
        assert_eq!(lines[0]["params"]["clientInfo"]["name"], "archductor-test");
        assert_eq!(
            lines[0]["params"]["workspaceFolders"][0]["uri"],
            "file:///tmp/workspace"
        );
        assert_eq!(lines[1], json!({"jsonrpc": "2.0", "method": "initialized"}));
    }

    #[test]
    fn fake_jsonl_messages_preserve_raw_json_and_classify_methods() {
        let input = Cursor::new(
            r#"{"jsonrpc":"2.0","method":"turn.started","params":{"turn_id":"t1"}}"#.to_owned()
                + "\n"
                + r#"{"jsonrpc":"2.0","method":"assistant.message.delta","params":{"text":"hi"}}"#
                + "\n"
                + r#"{"jsonrpc":"2.0","id":7,"method":"approval.request","params":{"action":"exec"}}"#
                + "\n",
        );

        let messages = read_jsonl_messages(input).unwrap();

        assert_eq!(messages.len(), 3);
        assert_eq!(
            messages[0].raw_json,
            r#"{"jsonrpc":"2.0","method":"turn.started","params":{"turn_id":"t1"}}"#
        );
        assert_eq!(
            messages[0].message_kind,
            CodexAppServerMessageKind::Notification
        );
        assert_eq!(messages[0].method.as_deref(), Some("turn.started"));

        let drafts: Vec<_> = messages
            .iter()
            .map(CodexAppServerMessage::to_provider_event_draft)
            .collect();

        assert_eq!(drafts[0].category, CodexProviderEventCategory::Turns);
        assert_eq!(
            drafts[1].category,
            CodexProviderEventCategory::AssistantOutput
        );
        assert_eq!(
            drafts[2].category,
            CodexProviderEventCategory::ApprovalsPermissions
        );
        assert_eq!(drafts[2].message_kind, CodexAppServerMessageKind::Request);
        assert_eq!(drafts[2].correlation_id.as_deref(), Some("7"));
        assert_eq!(drafts[2].raw_json, messages[2].raw_json);
    }

    #[test]
    fn provider_event_conversion_maps_tool_events_to_canonical_tool_kind() {
        let message = parse_jsonl_message(
            r#"{"jsonrpc":"2.0","method":"tool.call.delta","params":{"threadId":"thread-1","itemId":"tool-1","delta":"running"}}"#,
            1,
        )
        .unwrap();

        let event = message.to_provider_event_draft().into_provider_event_draft(
            crate::provider_events::ProviderEventContext {
                workspace_id: Some(1),
                chat_thread_id: Some(7),
                process_id: Some(9),
                occurred_at_ms: 42,
                schema_version: 1,
                adapter_version: "codex-app-server-test".to_owned(),
            },
        );

        assert_eq!(event.kind, crate::provider_events::ProviderEventKind::Tool);
        assert_eq!(
            event.phase,
            crate::provider_events::ProviderEventPhase::Delta
        );
        assert_eq!(event.provider_thread_id.as_deref(), Some("thread-1"));
        assert_eq!(event.provider_item_id.as_deref(), Some("tool-1"));
        assert_eq!(event.normalized_payload["body"], "running");
        assert_eq!(event.raw_json["method"], "tool.call.delta");
    }

    #[test]
    fn provider_event_conversion_preserves_unknown_future_raw_json() {
        let message = parse_jsonl_message(
            r#"{"jsonrpc":"2.0","method":"future.provider.thing","params":{"new":true}}"#,
            1,
        )
        .unwrap();

        let event = message.to_provider_event_draft().into_provider_event_draft(
            crate::provider_events::ProviderEventContext {
                workspace_id: None,
                chat_thread_id: Some(7),
                process_id: None,
                occurred_at_ms: 42,
                schema_version: 1,
                adapter_version: "codex-app-server-test".to_owned(),
            },
        );

        assert_eq!(
            event.kind,
            crate::provider_events::ProviderEventKind::Unknown
        );
        assert_eq!(event.raw_json["params"]["new"], true);
    }

    #[test]
    fn invalid_jsonl_reports_line_number_and_keeps_blank_lines_ignored() {
        let input = Cursor::new(
            "\n{\"jsonrpc\":\"2.0\",\"method\":\"session.created\"}\nnot-json\n".as_bytes(),
        );

        let error = read_jsonl_messages(input).unwrap_err().to_string();

        assert!(error.contains("line 3"), "{error}");
    }

    #[test]
    fn launch_command_uses_codex_app_server_stdio_jsonl() {
        let command = CodexAppServerLaunch::default();

        assert_eq!(command.executable, "codex");
        assert_eq!(command.args, vec!["app-server"]);
        assert_eq!(command.transport, CodexAppServerTransport::StdioJsonl);
    }
}
