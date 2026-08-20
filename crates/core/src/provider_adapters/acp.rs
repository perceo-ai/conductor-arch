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
                    "clientCapabilities": {
                        "fs": {"readTextFile": true, "writeTextFile": true},
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

    fn event(
        &mut self,
        kind: ProviderEventKind,
        phase: ProviderEventPhase,
        payload: Value,
        raw: Value,
    ) -> ProviderEventDraft {
        self.sequence += 1;
        ProviderEventDraft {
            provider: self.kind.as_str().to_owned(),
            provider_event_id: Some(format!("{}-{}", self.kind.as_str(), self.sequence)),
            provider_item_id: None,
            provider_thread_id: self.session_id.clone(),
            provider_turn_id: self
                .pending
                .as_ref()
                .map(|pending| pending.request_id.to_string()),
            parent_provider_item_id: None,
            parent_provider_thread_id: None,
            workspace_id: None,
            chat_thread_id: None,
            process_id: None,
            phase,
            kind,
            provider_subtype: None,
            provider_sequence: Some(self.sequence),
            occurred_at_ms: 0,
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
        vec![HarnessEffect::ProviderEvent(self.event(
            kind,
            phase,
            payload,
            raw.clone(),
        ))]
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
                workspace: String::new(),
                thread_id: 0,
                session_id: 0,
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

        if let Some(error) = message.get("error") {
            let text = error["message"].as_str().unwrap_or("ACP request failed");
            return vec![
                HarnessEffect::TurnCompleted {
                    local_input_id,
                    status: HarnessTurnStatus::Failed,
                },
                HarnessEffect::Fatal(text.to_owned()),
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
        let mut effects = vec![HarnessEffect::TurnCompleted {
            local_input_id,
            status,
        }];
        // max_tokens and max_turn_requests are truncations, not successes; the
        // turn is over either way but the user should be told why.
        if matches!(stop_reason, "max_tokens" | "max_turn_requests") {
            effects.push(HarnessEffect::Warning(format!(
                "the agent stopped early: {stop_reason}"
            )));
        }
        effects.push(HarnessEffect::TurnSettled { status });
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
            return vec![HarnessEffect::Fatal(
                "ACP session/new returned no sessionId".to_owned(),
            )];
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
}
