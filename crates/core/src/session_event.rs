use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::codex_tui::{
    detect_directory_trust_prompt, parse_codex_screen_delta, CodexFileChangeAction,
    CodexParseBenchmark, CodexParseCursor, CodexParsedItem, CodexTranscriptEvent,
    ScreenMessageRole,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEventDelta {
    pub events: Vec<SessionEvent>,
    pub cursor: CodexParseCursor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurred_at_ms: Option<u64>,
    pub source: SessionEventSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_text: Option<String>,
    pub payload: SessionEventPayload,
}

impl SessionEvent {
    pub fn new(
        source: SessionEventSource,
        raw_text: Option<String>,
        payload: SessionEventPayload,
    ) -> Self {
        Self {
            sequence: None,
            occurred_at_ms: None,
            source,
            raw_text,
            payload,
        }
    }

    pub fn with_sequence(mut self, sequence: u64) -> Self {
        self.sequence = Some(sequence);
        self
    }

    pub fn with_occurred_at_ms(mut self, occurred_at_ms: u64) -> Self {
        self.occurred_at_ms = Some(occurred_at_ms);
        self
    }

    pub fn render_text(&self) -> String {
        match &self.payload {
            SessionEventPayload::UserInput { text, .. }
            | SessionEventPayload::AssistantText { text }
            | SessionEventPayload::Prompt { text, .. } => text.clone(),
            SessionEventPayload::CommandOutput { title, output, .. } => {
                if output.is_empty() {
                    title.clone()
                } else {
                    format!("{title}\n{output}")
                }
            }
            SessionEventPayload::StatusChange { status, message } => message
                .clone()
                .unwrap_or_else(|| session_event_status_label(*status).to_owned()),
            SessionEventPayload::Error { message, .. } => message.clone(),
            SessionEventPayload::Metadata { entries } => entries
                .iter()
                .map(|(key, value)| format!("{key}: {}", value.render_text()))
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionEventSource {
    User,
    Assistant,
    Runtime,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEventPayload {
    UserInput {
        text: String,
        kind: SessionInputKind,
    },
    AssistantText {
        text: String,
    },
    CommandOutput {
        title: String,
        output: String,
        status: SessionCommandOutputStatus,
    },
    StatusChange {
        status: SessionEventStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Error {
        message: String,
        recoverable: bool,
    },
    Prompt {
        style: SessionPromptStyle,
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        options: Vec<SessionPromptOption>,
    },
    Metadata {
        entries: BTreeMap<String, SessionMetadataValue>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionInputKind {
    User,
    ReviewPrompt,
    ControlCommand,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionCommandOutputStatus {
    Unknown,
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionEventStatus {
    Starting,
    Running,
    WaitingForInput,
    Completed,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionPromptStyle {
    Text,
    Confirmation,
    Selection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionPromptOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum SessionMetadataValue {
    String(String),
    Number(serde_json::Number),
    Bool(bool),
}

impl SessionMetadataValue {
    fn render_text(&self) -> String {
        match self {
            Self::String(value) => value.clone(),
            Self::Number(value) => value.to_string(),
            Self::Bool(value) => value.to_string(),
        }
    }
}

pub fn codex_parsed_item_to_session_event(item: CodexParsedItem) -> SessionEvent {
    match item {
        CodexParsedItem::Message(message) => match message.role {
            ScreenMessageRole::User => SessionEvent::new(
                SessionEventSource::User,
                Some(message.content.clone()),
                SessionEventPayload::UserInput {
                    text: message.content,
                    kind: SessionInputKind::User,
                },
            ),
            ScreenMessageRole::Agent => SessionEvent::new(
                SessionEventSource::Assistant,
                Some(message.content.clone()),
                assistant_message_payload(message.content),
            ),
        },
        CodexParsedItem::Event(event) => codex_transcript_event_to_session_event(event),
    }
}

pub fn parse_codex_screen_event_delta(
    screen: &str,
    benchmark: &CodexParseBenchmark,
    previous_cursor: Option<&CodexParseCursor>,
) -> SessionEventDelta {
    let delta = parse_codex_screen_delta(screen, benchmark, previous_cursor);
    SessionEventDelta {
        events: delta
            .items
            .into_iter()
            .map(codex_parsed_item_to_session_event)
            .collect(),
        cursor: delta.cursor,
    }
}

pub fn codex_transcript_event_to_session_event(event: CodexTranscriptEvent) -> SessionEvent {
    match event {
        CodexTranscriptEvent::Tool { title, body } => SessionEvent::new(
            SessionEventSource::Runtime,
            Some(format!("Ran {title}\n{body}")),
            SessionEventPayload::CommandOutput {
                title,
                status: command_output_status(&body),
                output: body,
            },
        ),
        CodexTranscriptEvent::Skill { title, body } => SessionEvent::new(
            SessionEventSource::Runtime,
            Some(format!("Read SKILL.md ({title})\n{body}")),
            SessionEventPayload::CommandOutput {
                title: format!("skill: {title}"),
                output: body,
                status: SessionCommandOutputStatus::Unknown,
            },
        ),
        CodexTranscriptEvent::FileChange(change) => {
            let action = match change.action {
                CodexFileChangeAction::Added => "added",
                CodexFileChangeAction::Edited => "edited",
                CodexFileChangeAction::Deleted => "deleted",
            };
            let mut entries = BTreeMap::new();
            entries.insert(
                "kind".to_owned(),
                SessionMetadataValue::String("file_change".to_owned()),
            );
            entries.insert(
                "action".to_owned(),
                SessionMetadataValue::String(action.to_owned()),
            );
            entries.insert(
                "path".to_owned(),
                SessionMetadataValue::String(change.path.clone()),
            );
            if let Some(additions) = change.additions {
                entries.insert(
                    "additions".to_owned(),
                    SessionMetadataValue::Number(additions.into()),
                );
            }
            if let Some(deletions) = change.deletions {
                entries.insert(
                    "deletions".to_owned(),
                    SessionMetadataValue::Number(deletions.into()),
                );
            }
            SessionEvent::new(
                SessionEventSource::Runtime,
                Some(format!("{action} {}", change.path)),
                SessionEventPayload::Metadata { entries },
            )
        }
    }
}

fn assistant_message_payload(text: String) -> SessionEventPayload {
    if detect_directory_trust_prompt(&text) {
        return SessionEventPayload::Prompt {
            style: SessionPromptStyle::Confirmation,
            text: "Do you trust the contents of this directory?".to_owned(),
            options: vec![
                SessionPromptOption {
                    label: "Yes, continue".to_owned(),
                    value: "yes".to_owned(),
                },
                SessionPromptOption {
                    label: "No, exit".to_owned(),
                    value: "no".to_owned(),
                },
            ],
        };
    }

    if looks_like_error_message(&text) {
        return SessionEventPayload::Error {
            message: text,
            recoverable: false,
        };
    }

    SessionEventPayload::AssistantText { text }
}

fn command_output_status(output: &str) -> SessionCommandOutputStatus {
    let lower = output.to_ascii_lowercase();
    if lower.contains("error")
        || lower.contains("failed")
        || lower.contains("panic")
        || lower.contains("not found")
    {
        SessionCommandOutputStatus::Failed
    } else if lower.contains("ok")
        || lower.contains("success")
        || lower.contains("passed")
        || lower.contains("finished")
    {
        SessionCommandOutputStatus::Succeeded
    } else if lower.contains("running") {
        SessionCommandOutputStatus::Running
    } else {
        SessionCommandOutputStatus::Unknown
    }
}

fn looks_like_error_message(text: &str) -> bool {
    let lower = text.trim_start().to_ascii_lowercase();
    lower.starts_with("error:")
        || lower.starts_with("fatal:")
        || lower.starts_with("failed:")
        || lower.starts_with("panic:")
}

fn session_event_status_label(status: SessionEventStatus) -> &'static str {
    match status {
        SessionEventStatus::Starting => "starting",
        SessionEventStatus::Running => "running",
        SessionEventStatus::WaitingForInput => "waiting for input",
        SessionEventStatus::Completed => "completed",
        SessionEventStatus::Failed => "failed",
        SessionEventStatus::Stopped => "stopped",
    }
}
