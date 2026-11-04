//! Agent Client Protocol adapter.
//!
//! ACP is a JSON-RPC 2.0 protocol spoken over the agent's stdio, one message
//! per line. Unlike the Codex and Claude adapters, this one is not bound to a
//! single vendor: any agent that speaks ACP gets driven through it, which is
//! what makes provider breadth a registry entry rather than a new module.
//!
//! ACP agents land at [`HarnessTier::Partial`] and that is the honest answer,
//! not a gap to close later. The protocol has no session-control surface, and
//! `session/load` is an optional capability negotiated per agent at
//! `initialize`, so a static descriptor cannot promise resume or crash
//! recovery. Everything it *does* guarantee — thread-scoped sessions,
//! interrupts, permission prompts — is declared native.

use crate::archcar::harness_contract::{
    DesiredHarnessControls, HarnessAdapterContext, HarnessCapability, HarnessControl,
    HarnessControlPlan, HarnessDescriptor, HarnessEffect, HarnessFeature, HarnessInput,
    HarnessPreflightSpec, HarnessRecoveryCause, HarnessRecoveryPlan, HarnessTurnStatus,
    InteractionOption, InteractionQuestion, ManagedHarnessAdapter, NativeRecord, NativeWrite,
    ProviderInteractionDraft, ProviderInteractionKind, ProviderInteractionResolution, SupportMode,
    CORE_HARNESS_FEATURES, MANAGED_HARNESS_CONTRACT_VERSION,
};
use crate::provider_events::{ProviderEventDraft, ProviderEventKind, ProviderEventPhase};
use crate::session_kind::SessionKind;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub const ACP_ADAPTER_VERSION: &str = "acp-1";

/// The protocol revision this adapter implements.
pub const ACP_PROTOCOL_VERSION: u32 = 1;

const ACP_EXTENDED_FEATURES: &[(HarnessFeature, SupportMode)] = &[
    (HarnessFeature::ThreadScopedSession, SupportMode::Native),
    // ACP answers a prompt with its completion, not with a receipt, so the
    // daemon marks delivery itself once the request is written.
    (HarnessFeature::InputAcknowledgement, SupportMode::Emulated),
    (HarnessFeature::Queueing, SupportMode::Native),
    (HarnessFeature::Interrupt, SupportMode::Native),
    (
        HarnessFeature::Resume,
        SupportMode::Unsupported {
            reason: "ACP session/load is an optional capability negotiated per agent",
        },
    ),
    (
        HarnessFeature::CrashRecovery,
        SupportMode::Unsupported {
            reason: "without session/load a crashed ACP session cannot be rebuilt",
        },
    ),
    (
        HarnessFeature::SessionControls,
        SupportMode::Unsupported {
            reason: "ACP has no model, effort, or permission-mode control surface",
        },
    ),
    (HarnessFeature::ProviderInteractions, SupportMode::Native),
];

const ACP_OPTIONAL_CAPABILITIES: &[(HarnessCapability, SupportMode)] = &[
    (
        HarnessCapability::Goals,
        SupportMode::Unsupported {
            reason: "ACP has no goal or task surface",
        },
    ),
    (
        HarnessCapability::NativeSlashCommands,
        SupportMode::Unsupported {
            reason: "ACP prompts are content blocks, not command lines",
        },
    ),
];

/// Descriptors are `&'static`, but ACP serves many providers, so each
/// registered ACP agent gets one built on first use and cached. Without the
/// cache every call would leak another copy, and descriptors are compared by
/// pointer in places.
pub fn descriptor_for(kind: SessionKind) -> &'static HarnessDescriptor {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    static DESCRIPTORS: OnceLock<Mutex<HashMap<SessionKind, &'static HarnessDescriptor>>> =
        OnceLock::new();
    let cache = DESCRIPTORS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(existing) = cache.get(&kind) {
        return existing;
    }
    let descriptor = build_descriptor(kind);
    cache.insert(kind, descriptor);
    descriptor
}

fn build_descriptor(kind: SessionKind) -> &'static HarnessDescriptor {
    let tool = crate::agent_tools::tool_by_provider(kind.as_str());
    let display_name = tool.map(|tool| tool.display_name).unwrap_or(kind.as_str());
    let executable = tool
        .map(|tool| tool.default_command)
        .unwrap_or(kind.as_str());
    let preflight_command: &'static [&'static str] =
        Box::leak(vec![executable, "--version"].into_boxed_slice());

    Box::leak(Box::new(HarnessDescriptor {
        contract_version: MANAGED_HARNESS_CONTRACT_VERSION,
        kind,
        provider_key: kind.as_str(),
        display_name,
        default_executable: executable,
        preflight: HarnessPreflightSpec {
            command: preflight_command,
            auth_guidance: tool
                .map(|tool| tool.auth_guidance)
                .unwrap_or("Install and authenticate this agent."),
        },
        core_features: CORE_HARNESS_FEATURES,
        extended_features: ACP_EXTENDED_FEATURES,
        optional_capabilities: ACP_OPTIONAL_CAPABILITIES,
    }))
}

/// Tracks the one in-flight prompt. ACP allows a single active turn per
/// session, so correlating the `session/prompt` response back to the input that
/// started it only needs the request id, not a map.
#[derive(Debug)]
struct PendingTurn {
    request_id: i64,
    local_input_id: String,
    completed: bool,
}

pub struct AcpAdapter {
    kind: SessionKind,
    /// The chat thread and session row these events belong to. Without them the
    /// events persist unattached and nothing renders them in a chat.
    chat_thread_id: i64,
    process_id: i64,
    /// Carried onto permission asks: the chat lists them by workspace and
    /// thread, and answers are routed back by session id.
    workspace: String,
    session_id: Option<String>,
    next_request_id: i64,
    pending: Option<PendingTurn>,
    initialized: bool,
    sequence: i64,
}

impl AcpAdapter {
    pub fn new(kind: SessionKind, context: &HarnessAdapterContext) -> Self {
        Self {
            kind,
            chat_thread_id: context.thread_id,
            process_id: context.session_id,
            workspace: context.workspace.clone(),
            session_id: context.native_session_id.clone(),
            // 1 and 2 are reserved for the initialize / session_new handshake.
            next_request_id: 3,
            pending: None,
            initialized: false,
            sequence: 0,
        }
    }

    fn take_request_id(&mut self) -> i64 {
        let id = self.next_request_id;
        self.next_request_id += 1;
        id
    }

    fn write(&self, payload: Value, local_input_id: Option<String>) -> NativeWrite {
        NativeWrite {
            provider_key: self.kind.as_str(),
            local_input_id,
            payload: encode_line(&payload),
        }
    }

    /// True once the agent has answered `initialize`, which is when
    /// `session/new` may be sent.
    pub fn is_initialized(&self) -> bool {
        self.initialized
    }

    /// True once `session/new` has returned a session id. Before that there
    /// is no ACP session, so a fatal error leaves nothing worth keeping alive.
    pub fn is_established(&self) -> bool {
        self.session_id.is_some()
    }

    /// ACP allows one prompt in flight per session. A prompt is only writable
    /// once the session exists and the previous turn has been answered.
    pub fn can_accept_prompt(&self) -> bool {
        self.is_established()
            && self
                .pending
                .as_ref()
                .is_none_or(|pending| pending.completed)
    }

    /// The opening `initialize` request. Emitted by the session layer before
    /// any input is delivered.
    pub fn initialize_request(&mut self) -> NativeWrite {
        self.write(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": ACP_PROTOCOL_VERSION,
                    // Only capabilities this transport actually serves. An
                    // agent told we handle `fs/read_text_file` would block on a
                    // response nothing here sends; agents fall back to their
                    // own file access when it is off.
                    "clientCapabilities": {
                        "fs": {"readTextFile": false, "writeTextFile": false},
                    },
                },
            }),
            None,
        )
    }

    pub fn session_new_request(&mut self, cwd: &str) -> NativeWrite {
        self.write(
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/new",
                "params": {"cwd": cwd, "mcpServers": []},
            }),
            None,
        )
    }

    /// `item_id` is what makes a stream one card: the projection merges records
    /// that share a provider item id, so every chunk of one assistant message
    /// has to carry the same one. `None` leaves the record standing alone.
    fn event(
        &mut self,
        kind: ProviderEventKind,
        phase: ProviderEventPhase,
        payload: Value,
        raw: Value,
        item_id: Option<String>,
    ) -> ProviderEventDraft {
        self.sequence += 1;
        ProviderEventDraft {
            provider: self.kind.as_str().to_owned(),
            // The sequence restarts with every adapter, so the event id is
            // scoped to the session row: two chats on one provider would
            // otherwise both write `{provider}-1` and overwrite each other's
            // standalone records.
            provider_event_id: Some(format!(
                "{}-{}-{}",
                self.kind.as_str(),
                self.process_id,
                self.sequence
            )),
            provider_item_id: item_id,
            provider_thread_id: self.session_id.clone(),
            provider_turn_id: self
                .pending
                .as_ref()
                .map(|pending| pending.request_id.to_string()),
            parent_provider_item_id: None,
            parent_provider_thread_id: None,
            workspace_id: None,
            chat_thread_id: Some(self.chat_thread_id),
            process_id: Some(self.process_id),
            phase,
            kind,
            provider_subtype: None,
            provider_sequence: Some(self.sequence),
            occurred_at_ms: unix_millis(),
            normalized_payload: payload,
            raw_json: raw,
            schema_version: 1,
            adapter_version: ACP_ADAPTER_VERSION.to_owned(),
        }
    }

    fn handle_session_update(&mut self, params: &Value, raw: &Value) -> Vec<HarnessEffect> {
        let update = &params["update"];
        let Some(variant) = update["sessionUpdate"].as_str() else {
            return Vec::new();
        };
        let (kind, phase) = match variant {
            "agent_message_chunk" => (
                ProviderEventKind::AssistantOutput,
                ProviderEventPhase::Delta,
            ),
            "agent_thought_chunk" => (
                ProviderEventKind::PlanningReasoning,
                ProviderEventPhase::Delta,
            ),
            "user_message_chunk" => (ProviderEventKind::UserInput, ProviderEventPhase::Delta),
            "tool_call" => (ProviderEventKind::Tool, ProviderEventPhase::Started),
            "tool_call_update" => (ProviderEventKind::Tool, ProviderEventPhase::Progress),
            "plan" => (
                ProviderEventKind::PlanningReasoning,
                ProviderEventPhase::Progress,
            ),
            "available_commands_update" => (
                ProviderEventKind::EnvironmentConfigModel,
                ProviderEventPhase::Progress,
            ),
            // An unrecognised update is still recorded: dropping it would lose
            // transcript content whenever an agent ships ahead of this build.
            _ => (ProviderEventKind::Unknown, ProviderEventPhase::Progress),
        };
        let body = content_text(&update["content"])
            .or_else(|| update["title"].as_str().map(str::to_owned))
            .unwrap_or_default();
        let payload = json!({"title": variant, "body": body});
        let item_id = self.update_item_id(variant, update);
        vec![HarnessEffect::ProviderEvent(self.event(
            kind,
            phase,
            payload,
            raw.clone(),
            item_id,
        ))]
    }

    /// A stable id for the thing this update is about. A tool call is one card
    /// from its announcement to its result, and a message is one card however
    /// many chunks it streams in, so both key off the turn rather than off the
    /// individual record.
    fn update_item_id(&self, variant: &str, update: &Value) -> Option<String> {
        if let Some(tool_call_id) = update["toolCallId"].as_str() {
            return Some(format!("tool-{tool_call_id}"));
        }
        let turn = self
            .pending
            .as_ref()
            .map(|pending| pending.request_id.to_string())
            .unwrap_or_else(|| "boot".to_owned());
        match variant {
            "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk" => {
                Some(format!("{variant}-{turn}"))
            }
            // Anything else is a standalone record; giving it a shared id would
            // collapse unrelated updates into one card.
            _ => None,
        }
    }

    fn handle_permission_request(&mut self, id: &Value, params: &Value) -> Vec<HarnessEffect> {
        let options = params["options"]
            .as_array()
            .map(|options| {
                options
                    .iter()
                    .map(|option| InteractionOption {
                        label: option["name"]
                            .as_str()
                            .unwrap_or(option["optionId"].as_str().unwrap_or("Allow"))
                            .to_owned(),
                        description: option["kind"].as_str().unwrap_or_default().to_owned(),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let title = params["toolCall"]["title"]
            .as_str()
            .unwrap_or("Permission requested")
            .to_owned();
        // The JSON-RPC id is the only handle back to this ask; an answer
        // without it cannot be routed, so it is carried as the native id.
        let native_id = id.to_string();

        vec![HarnessEffect::InteractionRequested(
            ProviderInteractionDraft {
                provider_key: self.kind.as_str().to_owned(),
                workspace: self.workspace.clone(),
                thread_id: self.chat_thread_id,
                session_id: self.process_id,
                native_session_id: self.session_id.clone(),
                native_id: native_id.clone(),
                kind: ProviderInteractionKind::Permission,
                title: title.clone(),
                detail: params["toolCall"]["rawInput"].to_string(),
                questions: vec![InteractionQuestion {
                    id: native_id,
                    header: "Permission".to_owned(),
                    question: title,
                    options,
                    allow_other: false,
                    multi_select: false,
                }],
                auto_resolution_ms: None,
                native_request: params.clone(),
            },
        )]
    }

    fn handle_prompt_response(&mut self, message: &Value) -> Vec<HarnessEffect> {
        let Some(pending) = self.pending.as_mut() else {
            return Vec::new();
        };
        // Exactly-once: a duplicate response for a settled turn is ignored
        // rather than completing it twice.
        if pending.completed {
            return Vec::new();
        }
        pending.completed = true;
        let local_input_id = pending.local_input_id.clone();
        let turn_id = pending.request_id;

        if let Some(error) = message.get("error") {
            let text = error["message"].as_str().unwrap_or("ACP request failed");
            // A failed prompt ends its turn like any other: the transcript
            // needs the `Turn` record to stop showing it as running, and the
            // session is still there for the next message.
            return vec![
                HarnessEffect::TurnCompleted {
                    local_input_id,
                    status: HarnessTurnStatus::Failed,
                },
                HarnessEffect::ProviderEvent(self.event(
                    ProviderEventKind::Turn,
                    ProviderEventPhase::Failed,
                    json!({"title": "Turn", "body": text}),
                    message.clone(),
                    Some(format!("turn-{turn_id}")),
                )),
                HarnessEffect::Fatal(text.to_owned()),
                HarnessEffect::TurnSettled {
                    status: HarnessTurnStatus::Failed,
                },
                HarnessEffect::Ready,
            ];
        }

        let stop_reason = message["result"]["stopReason"]
            .as_str()
            .unwrap_or("end_turn");
        let status = match stop_reason {
            "cancelled" => HarnessTurnStatus::Interrupted,
            "refusal" => HarnessTurnStatus::Failed,
            _ => HarnessTurnStatus::Success,
        };
        let turn_phase = match status {
            HarnessTurnStatus::Success => ProviderEventPhase::Completed,
            HarnessTurnStatus::Interrupted => ProviderEventPhase::Interrupted,
            HarnessTurnStatus::Failed => ProviderEventPhase::Failed,
            // ACP has no deferral; mapped for completeness.
            HarnessTurnStatus::Deferred => ProviderEventPhase::Declined,
        };
        let mut effects = vec![HarnessEffect::TurnCompleted {
            local_input_id,
            status,
        }];
        // The transcript reads a turn's outcome off a `Turn` record. Without
        // one the turn renders as still running after the agent has answered.
        effects.push(HarnessEffect::ProviderEvent(self.event(
            ProviderEventKind::Turn,
            turn_phase,
            json!({"title": "Turn", "body": stop_reason}),
            message.clone(),
            Some(format!("turn-{turn_id}")),
        )));
        // max_tokens and max_turn_requests are truncations, not successes; the
        // turn is over either way but the user should be told why.
        if matches!(stop_reason, "max_tokens" | "max_turn_requests") {
            effects.push(HarnessEffect::Warning(format!(
                "the agent stopped early: {stop_reason}"
            )));
        }
        effects.push(HarnessEffect::TurnSettled { status });
        // ACP has no idle notification, so the end of a turn is the only moment
        // the session can be declared ready again. Without this it stays
        // "working" forever and every later message is queued behind a turn
        // that already finished.
        effects.push(HarnessEffect::Ready);
        effects
    }

    fn handle_initialize_response(&mut self, message: &Value) -> Vec<HarnessEffect> {
        self.initialized = true;
        let capabilities = message["result"]["agentCapabilities"]
            .as_object()
            .map(|caps| caps.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        vec![HarnessEffect::CapabilitiesObserved(capabilities)]
    }

    fn handle_session_new_response(&mut self, message: &Value) -> Vec<HarnessEffect> {
        let Some(session_id) = message["result"]["sessionId"].as_str() else {
            let reason = message["error"]["message"]
                .as_str()
                .map(|reason| format!("ACP session/new failed: {reason}"))
                .unwrap_or_else(|| "ACP session/new returned no sessionId".to_owned());
            return vec![HarnessEffect::Fatal(reason)];
        };
        self.session_id = Some(session_id.to_owned());
        vec![
            HarnessEffect::Initialized {
                native_session_id: session_id.to_owned(),
                model: None,
            },
            HarnessEffect::Ready,
        ]
    }
}

impl ManagedHarnessAdapter for AcpAdapter {
    fn encode_input(&mut self, input: HarnessInput) -> anyhow::Result<NativeWrite> {
        let session_id = self
            .session_id
            .clone()
            .ok_or_else(|| anyhow::anyhow!("ACP session is not established yet"))?;
        // Replacing an open turn would orphan its response, and with it the
        // turn's completion; the session layer holds a second prompt back.
        anyhow::ensure!(
            self.can_accept_prompt(),
            "an ACP turn is already running; the next prompt must wait for it"
        );
        let request_id = self.take_request_id();
        self.pending = Some(PendingTurn {
            request_id,
            local_input_id: input.local_input_id.clone(),
            completed: false,
        });
        Ok(self.write(
            json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/prompt",
                "params": {
                    "sessionId": session_id,
                    "prompt": [{"type": "text", "text": input.content}],
                },
            }),
            Some(input.local_input_id),
        ))
    }

    fn observe_native(&mut self, record: NativeRecord) -> anyhow::Result<Vec<HarnessEffect>> {
        let mut effects = Vec::new();
        for line in String::from_utf8_lossy(&record.payload).lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(line) else {
                // Agents print diagnostics to stdout; a non-JSON line is noise,
                // not a protocol violation worth failing the session over.
                continue;
            };

            if let Some(method) = message["method"].as_str() {
                match method {
                    "session/update" => {
                        effects.extend(self.handle_session_update(&message["params"], &message))
                    }
                    "session/request_permission" => effects
                        .extend(self.handle_permission_request(&message["id"], &message["params"])),
                    _ => {}
                }
                continue;
            }

            match message["id"].as_i64() {
                Some(1) => effects.extend(self.handle_initialize_response(&message)),
                Some(2) => effects.extend(self.handle_session_new_response(&message)),
                Some(id)
                    if self
                        .pending
                        .as_ref()
                        .is_some_and(|pending| pending.request_id == id) =>
                {
                    effects.extend(self.handle_prompt_response(&message))
                }
                _ => {}
            }
        }
        Ok(effects)
    }

    fn plan_control(&mut self, control: HarnessControl) -> HarnessControlPlan {
        match control {
            HarnessControl::Interrupt => match self.session_id.clone() {
                // session/cancel is a notification: no id, no response. The
                // turn ends via the prompt response with stopReason cancelled.
                Some(session_id) => HarnessControlPlan::NativeWrite(self.write(
                    json!({
                        "jsonrpc": "2.0",
                        "method": "session/cancel",
                        "params": {"sessionId": session_id},
                    }),
                    None,
                )),
                None => HarnessControlPlan::Unsupported {
                    reason: "no ACP session to cancel yet".to_owned(),
                },
            },
            HarnessControl::Kill => HarnessControlPlan::Signal(
                crate::archcar::harness_contract::HarnessSignal::TerminateProcessGroup,
            ),
            HarnessControl::ResolveInteraction {
                native_id,
                resolution,
            } => {
                let id: Value =
                    serde_json::from_str(&native_id).unwrap_or(Value::String(native_id));
                let outcome = match resolution {
                    ProviderInteractionResolution::Approve
                    | ProviderInteractionResolution::ApproveForSession => {
                        json!({"outcome": "selected", "optionId": "allow"})
                    }
                    ProviderInteractionResolution::Deny { .. } => {
                        json!({"outcome": "selected", "optionId": "reject"})
                    }
                    ProviderInteractionResolution::Answer { ref answers } => {
                        let option = answers
                            .first()
                            .and_then(|answer| answer.values.first().cloned())
                            .unwrap_or_else(|| "allow".to_owned());
                        json!({"outcome": "selected", "optionId": option})
                    }
                    ProviderInteractionResolution::Defer => json!({"outcome": "cancelled"}),
                };
                HarnessControlPlan::NativeWrite(self.write(
                    json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": outcome}}),
                    None,
                ))
            }
            // Declared unsupported in the descriptor; refusing here keeps the
            // two statements consistent instead of silently doing nothing.
            HarnessControl::SetModel(_)
            | HarnessControl::SetEffort(_)
            | HarnessControl::SetFastMode(_)
            | HarnessControl::SetPermissionMode(_) => HarnessControlPlan::Unsupported {
                reason: "ACP has no session control surface".to_owned(),
            },
        }
    }

    fn recovery_plan(&self, cause: HarnessRecoveryCause) -> HarnessRecoveryPlan {
        match cause {
            // No session/load guarantee means a dead process is a dead session.
            // Saying so beats silently starting a fresh one the user thinks is
            // their old conversation.
            HarnessRecoveryCause::ChildExited(code) => HarnessRecoveryPlan::Fail {
                message: format!(
                    "the ACP agent exited ({}) and its session cannot be resumed",
                    code.map(|code| code.to_string())
                        .unwrap_or_else(|| "signal".to_owned())
                ),
            },
            HarnessRecoveryCause::ProtocolError(message) => HarnessRecoveryPlan::Fail { message },
            HarnessRecoveryCause::InterruptDeadline => HarnessRecoveryPlan::Fail {
                message: "the ACP agent did not answer session/cancel".to_owned(),
            },
        }
    }
}

/// Unused today but part of the contract surface: controls that would require a
/// restart carry the desired state forward.
pub fn desired_controls_after_restart(controls: &DesiredHarnessControls) -> DesiredHarnessControls {
    controls.clone()
}

fn encode_line(payload: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(payload).unwrap_or_default();
    bytes.push(b'\n');
    bytes
}

/// ACP content is an array of typed blocks; the transcript wants the text.
fn content_text(content: &Value) -> Option<String> {
    if let Some(text) = content["text"].as_str() {
        return Some(text.to_owned());
    }
    let blocks = content.as_array()?;
    let joined = blocks
        .iter()
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("");
    (!joined.is_empty()).then_some(joined)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archcar::harness_contract::HarnessTier;

    fn adapter() -> AcpAdapter {
        AcpAdapter::new(
            SessionKind::new("gemini"),
            &HarnessAdapterContext {
                session_id: 7,
                thread_id: 11,
                workspace: "berlin".to_owned(),
                native_session_id: None,
                controls: DesiredHarnessControls::default(),
            },
        )
    }

    fn record(payload: &str) -> NativeRecord {
        NativeRecord {
            provider_key: "gemini",
            payload: format!("{payload}\n").into_bytes(),
        }
    }

    fn established() -> AcpAdapter {
        let mut adapter = adapter();
        adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess-1"}}"#,
            ))
            .unwrap();
        adapter
    }

    /// ACP agents are honestly partial: the protocol has no controls, and
    /// resume is optional per agent.
    #[test]
    fn acp_declares_partial_tier_with_written_reasons() {
        let descriptor = descriptor_for(SessionKind::new("gemini"));

        assert_eq!(descriptor.tier(), HarnessTier::Partial);
        assert!(descriptor.supports(HarnessFeature::Interrupt));
        assert!(descriptor.supports(HarnessFeature::ProviderInteractions));
        assert!(!descriptor.supports(HarnessFeature::Resume));
        assert!(!descriptor.supports(HarnessFeature::SessionControls));
        assert!(descriptor
            .extended(HarnessFeature::Resume)
            .reason()
            .is_some_and(|reason| reason.contains("session/load")));
        assert_eq!(descriptor.display_name, "Gemini CLI");
    }

    #[test]
    fn descriptor_registers_against_the_managed_contract() {
        // Uses the real validator, so a malformed ACP descriptor fails here
        // rather than at runtime.
        struct Harness(&'static HarnessDescriptor);
        impl crate::archcar::harness::HarnessController for Harness {
            fn kind(&self) -> SessionKind {
                self.0.kind
            }
            fn supports_auto_spawn(&self) -> bool {
                true
            }
            fn build_launch(
                &self,
                _store: &crate::workspace::WorkspaceStore,
                _workspace: &str,
                _harness: crate::workspace::SessionHarnessOptions,
            ) -> anyhow::Result<crate::workspace::SessionLaunch> {
                unreachable!("not exercised")
            }
        }
        impl crate::archcar::harness_contract::ManagedHarness for Harness {
            fn descriptor(&self) -> &'static HarnessDescriptor {
                self.0
            }
            fn create_adapter(
                &self,
                context: HarnessAdapterContext,
            ) -> anyhow::Result<Box<dyn ManagedHarnessAdapter>> {
                Ok(Box::new(AcpAdapter::new(self.0.kind, &context)))
            }
        }

        let harness = Harness(descriptor_for(SessionKind::new("opencode")));
        crate::archcar::harness::validate_managed_harness(&harness).expect("valid ACP descriptor");
    }

    #[test]
    fn handshake_establishes_the_session_and_reports_capabilities() {
        let mut adapter = adapter();

        let capabilities = adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{}}}}"#,
            ))
            .unwrap();
        assert!(capabilities.iter().any(|effect| matches!(
            effect,
            HarnessEffect::CapabilitiesObserved(observed) if observed.contains(&"loadSession".to_owned())
        )));

        let started = adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess-1"}}"#,
            ))
            .unwrap();
        assert!(started.iter().any(|effect| matches!(
            effect,
            HarnessEffect::Initialized { native_session_id, .. } if native_session_id == "sess-1"
        )));
        assert!(started
            .iter()
            .any(|effect| matches!(effect, HarnessEffect::Ready)));
    }

    /// Capabilities are a promise: claiming `fs` would have agents call
    /// `fs/read_text_file` and block forever on a reply this transport never
    /// sends.
    #[test]
    fn initialize_only_claims_capabilities_this_transport_serves() {
        let mut adapter = adapter();

        assert!(!adapter.is_initialized());
        let payload: Value = serde_json::from_slice(&adapter.initialize_request().payload).unwrap();

        assert_eq!(
            payload["params"]["clientCapabilities"]["fs"]["readTextFile"],
            false
        );
        assert_eq!(
            payload["params"]["clientCapabilities"]["fs"]["writeTextFile"],
            false
        );

        adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{}}}"#,
            ))
            .unwrap();

        // The session layer waits on this before sending `session/new`.
        assert!(adapter.is_initialized());
    }

    #[test]
    fn a_prompt_cannot_be_sent_before_the_session_exists() {
        let mut adapter = adapter();
        let error = adapter
            .encode_input(HarnessInput {
                local_input_id: "input-1".to_owned(),
                content: "hello".to_owned(),
                visible_content: None,
                kind: crate::archcar::protocol::ArchcarInputKind::User,
                delivery: crate::archcar::protocol::ArchcarInputDelivery::Auto,
            })
            .unwrap_err();

        assert!(error.to_string().contains("not established"));
    }

    #[test]
    fn prompts_become_session_prompt_requests_and_complete_exactly_once() {
        let mut adapter = established();
        let write = adapter
            .encode_input(HarnessInput {
                local_input_id: "input-1".to_owned(),
                content: "run the tests".to_owned(),
                visible_content: None,
                kind: crate::archcar::protocol::ArchcarInputKind::User,
                delivery: crate::archcar::protocol::ArchcarInputDelivery::Auto,
            })
            .unwrap();

        let payload: Value = serde_json::from_slice(&write.payload).unwrap();
        assert_eq!(payload["method"], "session/prompt");
        assert_eq!(payload["params"]["sessionId"], "sess-1");
        assert_eq!(payload["params"]["prompt"][0]["text"], "run the tests");
        assert_eq!(write.local_input_id.as_deref(), Some("input-1"));
        let request_id = payload["id"].as_i64().unwrap();

        let response = format!(
            r#"{{"jsonrpc":"2.0","id":{request_id},"result":{{"stopReason":"end_turn"}}}}"#
        );
        let effects = adapter.observe_native(record(&response)).unwrap();
        assert!(effects.iter().any(|effect| matches!(
            effect,
            HarnessEffect::TurnCompleted { local_input_id, status: HarnessTurnStatus::Success }
                if local_input_id == "input-1"
        )));

        // A repeated response must not complete the turn a second time.
        let duplicate = adapter.observe_native(record(&response)).unwrap();
        assert!(!duplicate
            .iter()
            .any(|effect| matches!(effect, HarnessEffect::TurnCompleted { .. })));
    }

    /// Nothing else marks an ACP session idle, so a finished turn has to.
    #[test]
    fn a_finished_turn_reports_the_outcome_and_leaves_the_session_ready() {
        let mut adapter = established();
        adapter
            .encode_input(HarnessInput {
                local_input_id: "input-1".to_owned(),
                content: "run the tests".to_owned(),
                visible_content: None,
                kind: crate::archcar::protocol::ArchcarInputKind::User,
                delivery: crate::archcar::protocol::ArchcarInputDelivery::Auto,
            })
            .unwrap();

        let effects = adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#,
            ))
            .unwrap();

        assert!(matches!(effects.last(), Some(HarnessEffect::Ready)));
        let turn = effects
            .iter()
            .find_map(|effect| match effect {
                HarnessEffect::ProviderEvent(draft) if draft.kind == ProviderEventKind::Turn => {
                    Some(draft)
                }
                _ => None,
            })
            .expect("a turn record carries the outcome into the transcript");
        assert_eq!(turn.phase, ProviderEventPhase::Completed);
        assert_eq!(turn.provider_item_id.as_deref(), Some("turn-3"));
    }

    #[test]
    fn stop_reasons_map_to_distinct_turn_statuses() {
        for (stop_reason, expected) in [
            ("end_turn", HarnessTurnStatus::Success),
            ("cancelled", HarnessTurnStatus::Interrupted),
            ("refusal", HarnessTurnStatus::Failed),
            ("max_tokens", HarnessTurnStatus::Success),
        ] {
            let mut adapter = established();
            let write = adapter
                .encode_input(HarnessInput {
                    local_input_id: "input-1".to_owned(),
                    content: "hi".to_owned(),
                    visible_content: None,
                    kind: crate::archcar::protocol::ArchcarInputKind::User,
                    delivery: crate::archcar::protocol::ArchcarInputDelivery::Auto,
                })
                .unwrap();
            let id: Value = serde_json::from_slice(&write.payload).unwrap();
            let id = id["id"].as_i64().unwrap();
            let effects = adapter
                .observe_native(record(&format!(
                    r#"{{"jsonrpc":"2.0","id":{id},"result":{{"stopReason":"{stop_reason}"}}}}"#
                )))
                .unwrap();

            assert!(
                effects.iter().any(|effect| matches!(
                    effect,
                    HarnessEffect::TurnCompleted { status, .. } if *status == expected
                )),
                "{stop_reason} did not map to {expected:?}"
            );
            // A truncated turn says why rather than looking like a clean finish.
            if stop_reason == "max_tokens" {
                assert!(effects
                    .iter()
                    .any(|effect| matches!(effect, HarnessEffect::Warning(_))));
            }
        }
    }

    #[test]
    fn session_updates_become_provider_events() {
        let mut adapter = established();
        let effects = adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working on it"}}}}"#,
            ))
            .unwrap();

        let HarnessEffect::ProviderEvent(event) = &effects[0] else {
            panic!("expected a provider event, got {effects:?}");
        };
        assert_eq!(event.kind, ProviderEventKind::AssistantOutput);
        assert_eq!(event.phase, ProviderEventPhase::Delta);
        assert_eq!(event.normalized_payload["body"], "working on it");
        assert_eq!(event.provider_thread_id.as_deref(), Some("sess-1"));
    }

    /// An agent shipping an update this build has never heard of still gets its
    /// content into the transcript.
    #[test]
    fn unknown_session_updates_are_recorded_rather_than_dropped() {
        let mut adapter = established();
        let effects = adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"brand_new_thing","content":{"type":"text","text":"payload"}}}}"#,
            ))
            .unwrap();

        let HarnessEffect::ProviderEvent(event) = &effects[0] else {
            panic!("expected a provider event");
        };
        assert_eq!(event.kind, ProviderEventKind::Unknown);
        assert_eq!(event.normalized_payload["body"], "payload");
    }

    #[test]
    fn permission_requests_round_trip_through_the_interaction_surface() {
        let mut adapter = established();
        let effects = adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","id":42,"method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{"title":"Write src/main.rs","rawInput":{"path":"src/main.rs"}},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}"#,
            ))
            .unwrap();

        let HarnessEffect::InteractionRequested(draft) = &effects[0] else {
            panic!("expected an interaction request");
        };
        assert_eq!(draft.kind, ProviderInteractionKind::Permission);
        assert_eq!(draft.title, "Write src/main.rs");
        assert_eq!(draft.native_id, "42");
        assert_eq!(draft.questions[0].options.len(), 2);

        let plan = adapter.plan_control(HarnessControl::ResolveInteraction {
            native_id: draft.native_id.clone(),
            resolution: ProviderInteractionResolution::Approve,
        });
        let HarnessControlPlan::NativeWrite(write) = plan else {
            panic!("a permission answer must go back over the live session");
        };
        let payload: Value = serde_json::from_slice(&write.payload).unwrap();
        // The id must survive as a number, or the agent cannot correlate it.
        assert_eq!(payload["id"], 42);
        assert_eq!(payload["result"]["outcome"]["outcome"], "selected");
        assert_eq!(payload["result"]["outcome"]["optionId"], "allow");
    }

    #[test]
    fn interrupt_sends_session_cancel_as_a_notification() {
        let mut adapter = established();
        let plan = adapter.plan_control(HarnessControl::Interrupt);

        let HarnessControlPlan::NativeWrite(write) = plan else {
            panic!("expected a cancel write");
        };
        let payload: Value = serde_json::from_slice(&write.payload).unwrap();
        assert_eq!(payload["method"], "session/cancel");
        assert_eq!(payload["params"]["sessionId"], "sess-1");
        // Notifications carry no id; an id would make the agent expect a reply.
        assert!(payload.get("id").is_none());
    }

    #[test]
    fn unsupported_controls_are_refused_rather_than_ignored() {
        let mut adapter = established();

        for control in [
            HarnessControl::SetModel(Some("fast".to_owned())),
            HarnessControl::SetEffort(Some("high".to_owned())),
            HarnessControl::SetPermissionMode(Some("plan".to_owned())),
        ] {
            assert!(
                matches!(
                    adapter.plan_control(control),
                    HarnessControlPlan::Unsupported { .. }
                ),
                "ACP must refuse controls it declared unsupported"
            );
        }
    }

    #[test]
    fn a_dead_agent_fails_instead_of_silently_starting_a_new_conversation() {
        let adapter = established();

        assert!(matches!(
            adapter.recovery_plan(HarnessRecoveryCause::ChildExited(Some(1))),
            HarnessRecoveryPlan::Fail { ref message } if message.contains("cannot be resumed")
        ));
    }

    #[test]
    fn non_json_output_is_ignored_rather_than_failing_the_session() {
        let mut adapter = established();
        let effects = adapter
            .observe_native(NativeRecord {
                provider_key: "gemini",
                payload: b"loading model...\nnot json at all\n".to_vec(),
            })
            .unwrap();

        assert!(effects.is_empty());
    }

    #[test]
    fn a_failed_prompt_reports_the_error_and_ends_the_turn() {
        let mut adapter = established();
        let write = adapter
            .encode_input(HarnessInput {
                local_input_id: "input-1".to_owned(),
                content: "hi".to_owned(),
                visible_content: None,
                kind: crate::archcar::protocol::ArchcarInputKind::User,
                delivery: crate::archcar::protocol::ArchcarInputDelivery::Auto,
            })
            .unwrap();
        let id: Value = serde_json::from_slice(&write.payload).unwrap();
        let id = id["id"].as_i64().unwrap();

        let effects = adapter
            .observe_native(record(&format!(
                r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":-32000,"message":"context length exceeded"}}}}"#
            )))
            .unwrap();

        assert!(effects.iter().any(|effect| matches!(
            effect,
            HarnessEffect::TurnCompleted {
                status: HarnessTurnStatus::Failed,
                ..
            }
        )));
        assert!(effects.iter().any(|effect| matches!(
            effect,
            HarnessEffect::Fatal(message) if message.contains("context length exceeded")
        )));
    }

    /// The interaction surface shows and answers an ask through the chat and
    /// session that raised it, so the draft has to carry them.
    #[test]
    fn permission_requests_name_the_workspace_thread_and_session_that_asked() {
        let mut adapter = established();
        let effects = adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","id":42,"method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{"title":"Write src/main.rs"},"options":[]}}"#,
            ))
            .unwrap();

        let HarnessEffect::InteractionRequested(draft) = &effects[0] else {
            panic!("expected an interaction request");
        };
        assert_eq!(draft.workspace, "berlin");
        assert_eq!(draft.thread_id, 11);
        assert_eq!(draft.session_id, 7);
        assert_eq!(draft.native_session_id.as_deref(), Some("sess-1"));
    }

    /// A prompt answered with a JSON-RPC error still gets its `Turn` record:
    /// the transcript reads a turn's outcome off that record, so without it
    /// the failed turn renders as running forever.
    #[test]
    fn a_failed_prompt_writes_a_failed_turn_record() {
        let mut adapter = established();
        adapter
            .encode_input(HarnessInput {
                local_input_id: "input-1".to_owned(),
                content: "hi".to_owned(),
                visible_content: None,
                kind: crate::archcar::protocol::ArchcarInputKind::User,
                delivery: crate::archcar::protocol::ArchcarInputDelivery::Auto,
            })
            .unwrap();

        let effects = adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"context length exceeded"}}"#,
            ))
            .unwrap();

        let turn = effects
            .iter()
            .find_map(|effect| match effect {
                HarnessEffect::ProviderEvent(draft) if draft.kind == ProviderEventKind::Turn => {
                    Some(draft)
                }
                _ => None,
            })
            .expect("a failed prompt still records its turn");
        assert_eq!(turn.phase, ProviderEventPhase::Failed);
        assert_eq!(turn.provider_item_id.as_deref(), Some("turn-3"));
    }

    /// ACP allows one prompt in flight; a second encode while the first turn
    /// is open must be refused, not replace the turn whose response is still
    /// coming.
    #[test]
    fn a_second_prompt_is_refused_while_a_turn_is_open() {
        let mut adapter = established();
        let input = |id: &str| HarnessInput {
            local_input_id: id.to_owned(),
            content: "hi".to_owned(),
            visible_content: None,
            kind: crate::archcar::protocol::ArchcarInputKind::User,
            delivery: crate::archcar::protocol::ArchcarInputDelivery::Auto,
        };
        adapter.encode_input(input("input-1")).unwrap();
        assert!(!adapter.can_accept_prompt());
        assert!(adapter.encode_input(input("input-2")).is_err());

        let effects = adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#,
            ))
            .unwrap();
        assert!(effects.iter().any(|effect| matches!(
            effect,
            HarnessEffect::TurnCompleted { local_input_id, .. } if local_input_id == "input-1"
        )));
        assert!(adapter.can_accept_prompt());
    }

    /// The optionId in a permission reply has to be one the agent offered.
    /// Agents name their options freely, so a literal "allow" is an id most of
    /// them never advertised.
    #[test]
    fn permission_replies_carry_the_option_id_the_agent_offered() {
        let ask = r#"{"jsonrpc":"2.0","id":42,"method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{"title":"Write src/main.rs"},"options":[{"optionId":"proceed_once","name":"Yes","kind":"allow_once"},{"optionId":"proceed_always","name":"Always","kind":"allow_always"},{"optionId":"decline","name":"No","kind":"reject_once"}]}}"#;
        for (resolution, expected) in [
            (ProviderInteractionResolution::Approve, "proceed_once"),
            (
                ProviderInteractionResolution::ApproveForSession,
                "proceed_always",
            ),
            (
                ProviderInteractionResolution::Deny { reason: None },
                "decline",
            ),
            (
                ProviderInteractionResolution::Answer {
                    answers: vec![crate::archcar::harness_contract::InteractionAnswer {
                        question_id: "42".to_owned(),
                        values: vec!["Always".to_owned()],
                    }],
                },
                "proceed_always",
            ),
        ] {
            let mut adapter = established();
            adapter.observe_native(record(ask)).unwrap();

            let plan = adapter.plan_control(HarnessControl::ResolveInteraction {
                native_id: "42".to_owned(),
                resolution: resolution.clone(),
            });

            let HarnessControlPlan::NativeWrite(write) = plan else {
                panic!("a permission answer must go back over the live session");
            };
            let payload: Value = serde_json::from_slice(&write.payload).unwrap();
            assert_eq!(payload["id"], 42);
            assert_eq!(
                payload["result"]["outcome"],
                json!({"outcome": "selected", "optionId": expected}),
                "{resolution:?}"
            );
        }
    }

    /// When the agent offered nothing that means what the user chose, the
    /// honest reply is a cancellation, not an id it never advertised.
    #[test]
    fn permission_replies_never_invent_an_option_the_agent_did_not_offer() {
        let mut adapter = established();
        adapter
            .observe_native(record(
                r#"{"jsonrpc":"2.0","id":42,"method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{"title":"Write src/main.rs"},"options":[{"optionId":"proceed_once","name":"Yes","kind":"allow_once"}]}}"#,
            ))
            .unwrap();

        let plan = adapter.plan_control(HarnessControl::ResolveInteraction {
            native_id: "42".to_owned(),
            resolution: ProviderInteractionResolution::Deny { reason: None },
        });

        let HarnessControlPlan::NativeWrite(write) = plan else {
            panic!("a permission answer must go back over the live session");
        };
        let payload: Value = serde_json::from_slice(&write.payload).unwrap();
        assert_eq!(
            payload["result"]["outcome"],
            json!({"outcome": "cancelled"})
        );
    }
}
