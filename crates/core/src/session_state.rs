use serde::{Deserialize, Serialize};

use crate::session_event::{
    SessionCommandOutputStatus, SessionEvent, SessionEventPayload, SessionEventStatus,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionState {
    Starting,
    Running,
    Streaming,
    WaitingForInput,
    ToolRunning,
    Interrupted,
    Failed,
    Exited,
    Archived,
}

impl AgentSessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Streaming => "streaming",
            Self::WaitingForInput => "waiting_for_input",
            Self::ToolRunning => "tool_running",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
            Self::Exited => "exited",
            Self::Archived => "archived",
        }
    }

    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Interrupted | Self::Failed | Self::Exited | Self::Archived
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidSessionTransition {
    pub from: AgentSessionState,
    pub to: AgentSessionState,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionStateMachine {
    state: AgentSessionState,
    invalid_transitions: Vec<InvalidSessionTransition>,
}

impl Default for SessionStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionStateMachine {
    pub fn new() -> Self {
        Self {
            state: AgentSessionState::Starting,
            invalid_transitions: Vec::new(),
        }
    }

    pub fn from_state(state: AgentSessionState) -> Self {
        Self {
            state,
            invalid_transitions: Vec::new(),
        }
    }

    pub fn state(&self) -> AgentSessionState {
        self.state
    }

    pub fn invalid_transitions(&self) -> &[InvalidSessionTransition] {
        &self.invalid_transitions
    }

    pub fn apply_event(&mut self, event: &SessionEvent) {
        let next = match &event.payload {
            SessionEventPayload::UserInput { .. } => AgentSessionState::Running,
            SessionEventPayload::AssistantText { .. } => AgentSessionState::Streaming,
            SessionEventPayload::CommandOutput { status, .. } => match status {
                SessionCommandOutputStatus::Running | SessionCommandOutputStatus::Unknown => {
                    AgentSessionState::ToolRunning
                }
                SessionCommandOutputStatus::Succeeded => AgentSessionState::Running,
                SessionCommandOutputStatus::Failed => AgentSessionState::Failed,
            },
            SessionEventPayload::StatusChange { status, .. } => match status {
                SessionEventStatus::Starting => AgentSessionState::Starting,
                SessionEventStatus::Running => AgentSessionState::Running,
                SessionEventStatus::WaitingForInput => AgentSessionState::WaitingForInput,
                SessionEventStatus::Completed => AgentSessionState::Exited,
                SessionEventStatus::Failed => AgentSessionState::Failed,
                SessionEventStatus::Stopped => AgentSessionState::Interrupted,
            },
            SessionEventPayload::Error { recoverable, .. } => {
                if *recoverable {
                    AgentSessionState::WaitingForInput
                } else {
                    AgentSessionState::Failed
                }
            }
            SessionEventPayload::Prompt { .. } => AgentSessionState::WaitingForInput,
            SessionEventPayload::Metadata { .. } => self.state,
        };
        self.transition(next, event.raw_text.as_deref().unwrap_or("session event"));
    }

    pub fn apply_events<'a>(&mut self, events: impl IntoIterator<Item = &'a SessionEvent>) {
        for event in events {
            self.apply_event(event);
        }
    }

    pub fn mark_interrupted(&mut self, reason: impl Into<String>) {
        let reason = reason.into();
        self.transition(AgentSessionState::Interrupted, &reason);
    }

    pub fn mark_exited(&mut self, exit_code: Option<i32>) {
        if matches!(exit_code, Some(code) if code != 0) {
            self.transition(AgentSessionState::Failed, "process exited with failure");
        } else {
            self.transition(AgentSessionState::Exited, "process exited");
        }
    }

    pub fn mark_archived(&mut self) {
        self.transition(AgentSessionState::Archived, "workspace archived");
    }

    fn transition(&mut self, to: AgentSessionState, reason: &str) {
        if self.state == to {
            return;
        }
        if self.state.is_terminal() && to != AgentSessionState::Archived {
            self.invalid_transitions.push(InvalidSessionTransition {
                from: self.state,
                to,
                reason: reason.to_owned(),
            });
            return;
        }
        self.state = to;
    }
}
