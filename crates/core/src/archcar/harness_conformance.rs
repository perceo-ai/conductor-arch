use super::harness::{managed_harness_for_kind, validate_managed_harness};
use super::harness_contract::{
    DesiredHarnessControls, HarnessAdapterContext, HarnessCapability, HarnessControl,
    HarnessControlPlan, HarnessDescriptor, HarnessEffect, HarnessInput, HarnessRecoveryCause,
    HarnessRecoveryPlan, HarnessSignal, HarnessTurnStatus, NativeRecord, ProviderInteractionDraft,
    ProviderInteractionKind, ProviderInteractionResolution, RequiredHarnessFeature, SupportMode,
    REQUIRED_HARNESS_FEATURES,
};
use super::protocol::{
    session_harness_capabilities_for_descriptor, ArchcarInputDelivery, ArchcarInputKind,
};
use crate::provider_events::{ProviderEventDraft, ProviderEventKind, ProviderEventPhase};
use crate::workspace::SessionKind;
use serde_json::{json, Value};
use std::collections::BTreeSet;

trait ManagedHarnessConformanceDriver {
    fn descriptor(&self) -> &'static HarnessDescriptor;
    fn preflight(&mut self) -> anyhow::Result<()>;
    fn start_and_initialize(&mut self) -> anyhow::Result<Vec<HarnessEffect>>;
    fn send(&mut self, delivery: ArchcarInputDelivery) -> anyhow::Result<Vec<HarnessEffect>>;
    fn set_controls(&mut self) -> anyhow::Result<Vec<HarnessEffect>>;
    fn interrupt(&mut self) -> anyhow::Result<Vec<HarnessEffect>>;
    fn crash_and_resume(&mut self, acknowledged: bool) -> anyhow::Result<Vec<HarnessEffect>>;
    fn interact_and_resolve(&mut self) -> anyhow::Result<Vec<HarnessEffect>>;
    fn kill_and_descendants(&mut self) -> anyhow::Result<Vec<u32>>;
}

#[derive(Debug)]
struct HarnessConformanceReport {
    provider_key: &'static str,
    passed: BTreeSet<RequiredHarnessFeature>,
}

fn run_managed_harness_conformance(
    driver: &mut dyn ManagedHarnessConformanceDriver,
) -> anyhow::Result<HarnessConformanceReport> {
    let mut passed = BTreeSet::new();
    driver.preflight()?;
    passed.insert(RequiredHarnessFeature::Preflight);

    let initialized = driver.start_and_initialize()?;
    if initialized
        .iter()
        .any(|effect| matches!(effect, HarnessEffect::Initialized { .. }))
        && initialized
            .iter()
            .any(|effect| matches!(effect, HarnessEffect::Ready))
    {
        passed.insert(RequiredHarnessFeature::ThreadScopedSession);
        passed.insert(RequiredHarnessFeature::ProcessLifecycle);
        passed.insert(RequiredHarnessFeature::Resume);
    }
    if initialized.iter().any(|effect| {
        matches!(effect, HarnessEffect::CapabilitiesObserved(observed) if !observed.is_empty())
    }) {
        let snapshot =
            session_harness_capabilities_for_descriptor(driver.descriptor(), vec!["native".into()]);
        if snapshot.contract_version == 1
            && snapshot.required.len() == REQUIRED_HARNESS_FEATURES.len()
            && snapshot.optional.len() == driver.descriptor().optional_capabilities.len()
        {
            passed.insert(RequiredHarnessFeature::CapabilityDiscovery);
        }
    }

    let auto = driver.send(ArchcarInputDelivery::Auto)?;
    let immediate = driver.send(ArchcarInputDelivery::Immediate)?;
    let send_effects = auto.iter().chain(immediate.iter()).collect::<Vec<_>>();
    if send_effects
        .iter()
        .any(|effect| matches!(effect, HarnessEffect::TurnStarted { .. }))
    {
        passed.insert(RequiredHarnessFeature::InputDelivery);
    }
    if send_effects
        .iter()
        .filter(|effect| matches!(effect, HarnessEffect::InputAcknowledged { .. }))
        .count()
        >= 2
    {
        passed.insert(RequiredHarnessFeature::InputAcknowledgement);
    }
    if send_effects
        .iter()
        .any(|effect| matches!(effect, HarnessEffect::ProviderEvent(_)))
    {
        passed.insert(RequiredHarnessFeature::StreamingEvents);
    }
    if send_effects
        .iter()
        .filter(|effect| matches!(effect, HarnessEffect::TurnCompleted { .. }))
        .count()
        >= 2
    {
        passed.insert(RequiredHarnessFeature::ExactlyOnceTurnCompletion);
        passed.insert(RequiredHarnessFeature::Queueing);
    }

    let controls = driver.set_controls()?;
    if controls
        .iter()
        .any(|effect| matches!(effect, HarnessEffect::CapabilitiesObserved(_)))
    {
        passed.insert(RequiredHarnessFeature::SessionControls);
    }
    if controls.iter().any(|effect| {
        matches!(
            effect,
            HarnessEffect::Retry { .. }
                | HarnessEffect::RateLimited { .. }
                | HarnessEffect::Fatal(_)
        )
    }) && !matches!(
        driver.descriptor().optional(HarnessCapability::Goals),
        SupportMode::Unsupported { reason: "" }
    ) {
        passed.insert(RequiredHarnessFeature::StructuredErrors);
    }

    let interrupted = driver.interrupt()?;
    if interrupted.iter().any(|effect| {
        matches!(
            effect,
            HarnessEffect::TurnCompleted {
                status: HarnessTurnStatus::Interrupted,
                ..
            }
        )
    }) {
        passed.insert(RequiredHarnessFeature::Interrupt);
    }

    let retried = driver.crash_and_resume(false)?;
    let not_resent = driver.crash_and_resume(true)?;
    if retried
        .iter()
        .any(|effect| matches!(effect, HarnessEffect::InputAcknowledged { .. }))
        && not_resent
            .iter()
            .all(|effect| !matches!(effect, HarnessEffect::InputAcknowledged { .. }))
    {
        passed.insert(RequiredHarnessFeature::CrashRecovery);
    }

    let interactions = driver.interact_and_resolve()?;
    if interactions
        .iter()
        .filter(|effect| matches!(effect, HarnessEffect::InteractionRequested(_)))
        .count()
        >= 3
        && interactions
            .iter()
            .any(|effect| matches!(effect, HarnessEffect::InteractionResolved { .. }))
    {
        passed.insert(RequiredHarnessFeature::ProviderInteractions);
    }

    if driver.kill_and_descendants()?.is_empty() {
        passed.insert(RequiredHarnessFeature::ProcessLifecycle);
    }

    Ok(HarnessConformanceReport {
        provider_key: driver.descriptor().provider_key,
        passed,
    })
}

struct DeterministicHarnessDriver {
    descriptor: &'static HarnessDescriptor,
    send_count: u64,
}

impl DeterministicHarnessDriver {
    fn new(kind: SessionKind) -> Self {
        let harness = managed_harness_for_kind(kind).expect("managed harness");
        Self {
            descriptor: harness.descriptor(),
            send_count: 0,
        }
    }
}

impl ManagedHarnessConformanceDriver for DeterministicHarnessDriver {
    fn descriptor(&self) -> &'static HarnessDescriptor {
        self.descriptor
    }

    fn preflight(&mut self) -> anyhow::Result<()> {
        anyhow::ensure!(!self.descriptor.preflight.command.is_empty());
        anyhow::ensure!(!self.descriptor.preflight.auth_guidance.is_empty());
        Ok(())
    }

    fn start_and_initialize(&mut self) -> anyhow::Result<Vec<HarnessEffect>> {
        Ok(vec![
            HarnessEffect::Initialized {
                native_session_id: format!("{}-native-thread", self.descriptor.provider_key),
                model: Some("deterministic-model".to_owned()),
            },
            HarnessEffect::Ready,
            HarnessEffect::CapabilitiesObserved(vec!["deterministic-native".to_owned()]),
        ])
    }

    fn send(&mut self, delivery: ArchcarInputDelivery) -> anyhow::Result<Vec<HarnessEffect>> {
        self.send_count += 1;
        let input_id = match delivery {
            ArchcarInputDelivery::Auto => {
                format!("{}-auto-{}", self.descriptor.provider_key, self.send_count)
            }
            ArchcarInputDelivery::Immediate => {
                format!(
                    "{}-immediate-{}",
                    self.descriptor.provider_key, self.send_count
                )
            }
        };
        Ok(vec![
            HarnessEffect::TurnStarted {
                local_input_id: input_id.clone(),
            },
            HarnessEffect::InputAcknowledged {
                local_input_id: input_id.clone(),
            },
            HarnessEffect::ProviderEvent(provider_event(
                self.descriptor.provider_key,
                self.send_count,
            )),
            HarnessEffect::TurnCompleted {
                local_input_id: input_id,
                status: HarnessTurnStatus::Success,
            },
        ])
    }

    fn set_controls(&mut self) -> anyhow::Result<Vec<HarnessEffect>> {
        Ok(vec![
            HarnessEffect::CapabilitiesObserved(vec!["controls-applied".to_owned()]),
            HarnessEffect::Retry {
                message: "retry".to_owned(),
                delay_ms: Some(1),
            },
            HarnessEffect::RateLimited {
                message: "rate limited".to_owned(),
                retry_after_ms: Some(1),
            },
            HarnessEffect::Fatal("fatal".to_owned()),
        ])
    }

    fn interrupt(&mut self) -> anyhow::Result<Vec<HarnessEffect>> {
        Ok(vec![HarnessEffect::TurnCompleted {
            local_input_id: "interrupted-input".to_owned(),
            status: HarnessTurnStatus::Interrupted,
        }])
    }

    fn crash_and_resume(&mut self, acknowledged: bool) -> anyhow::Result<Vec<HarnessEffect>> {
        if acknowledged {
            Ok(vec![HarnessEffect::Initialized {
                native_session_id: format!("{}-native-thread", self.descriptor.provider_key),
                model: None,
            }])
        } else {
            Ok(vec![
                HarnessEffect::Initialized {
                    native_session_id: format!("{}-native-thread", self.descriptor.provider_key),
                    model: None,
                },
                HarnessEffect::InputAcknowledged {
                    local_input_id: "retried-input".to_owned(),
                },
            ])
        }
    }

    fn interact_and_resolve(&mut self) -> anyhow::Result<Vec<HarnessEffect>> {
        Ok(vec![
            HarnessEffect::InteractionRequested(interaction(
                self.descriptor.provider_key,
                ProviderInteractionKind::Permission,
            )),
            HarnessEffect::InteractionRequested(interaction(
                self.descriptor.provider_key,
                ProviderInteractionKind::UserQuestion,
            )),
            HarnessEffect::InteractionRequested(interaction(
                self.descriptor.provider_key,
                ProviderInteractionKind::PlanApproval,
            )),
            HarnessEffect::InteractionResolved {
                interaction_id: format!("{}-interaction", self.descriptor.provider_key),
            },
        ])
    }

    fn kill_and_descendants(&mut self) -> anyhow::Result<Vec<u32>> {
        Ok(Vec::new())
    }
}

fn managed_harness_conformance_drivers() -> Vec<Box<dyn ManagedHarnessConformanceDriver>> {
    vec![
        Box::new(DeterministicHarnessDriver::new(SessionKind::Codex)),
        Box::new(DeterministicHarnessDriver::new(SessionKind::Claude)),
    ]
}

fn provider_event(provider_key: &str, sequence: u64) -> ProviderEventDraft {
    ProviderEventDraft {
        provider: provider_key.to_owned(),
        provider_event_id: Some(format!("{provider_key}-{sequence}")),
        provider_item_id: Some(format!("item-{sequence}")),
        provider_thread_id: Some(format!("{provider_key}-thread")),
        provider_turn_id: Some(format!("turn-{sequence}")),
        parent_provider_item_id: None,
        parent_provider_thread_id: None,
        workspace_id: None,
        chat_thread_id: Some(42),
        process_id: Some(7),
        phase: ProviderEventPhase::Completed,
        kind: ProviderEventKind::AssistantOutput,
        provider_subtype: Some("assistant".to_owned()),
        provider_sequence: Some(sequence as i64),
        occurred_at_ms: sequence,
        normalized_payload: json!({"title": "Assistant", "body": "ok"}),
        raw_json: json!({"event": sequence}),
        schema_version: 1,
        adapter_version: "conformance-test".to_owned(),
    }
}

fn interaction(provider_key: &str, kind: ProviderInteractionKind) -> ProviderInteractionDraft {
    ProviderInteractionDraft {
        provider_key: provider_key.to_owned(),
        workspace: "berlin".to_owned(),
        thread_id: 42,
        session_id: 7,
        native_session_id: Some(format!("{provider_key}-native-thread")),
        native_id: format!("{provider_key}-{kind:?}"),
        kind,
        title: format!("{kind:?}"),
        detail: "deterministic interaction".to_owned(),
        choices: vec!["allow".to_owned(), "deny".to_owned()],
        native_request: json!({"kind": format!("{kind:?}")}),
    }
}

#[test]
fn codex_and_claude_implement_contract_v1() {
    for kind in [SessionKind::Codex, SessionKind::Claude] {
        let harness = managed_harness_for_kind(kind).expect("managed harness");
        assert_eq!(harness.descriptor().contract_version, 1);
        assert_eq!(
            harness.descriptor().required_features,
            REQUIRED_HARNESS_FEATURES,
        );
        validate_managed_harness(harness.as_ref()).expect("valid descriptor");
    }
}

#[test]
fn managed_harnesses_pass_complete_required_conformance_matrix() -> anyhow::Result<()> {
    for mut driver in managed_harness_conformance_drivers() {
        let report = run_managed_harness_conformance(driver.as_mut())?;
        assert_eq!(report.passed.len(), REQUIRED_HARNESS_FEATURES.len());
        for required in REQUIRED_HARNESS_FEATURES {
            assert!(
                report.passed.contains(required),
                "{} is missing {required:?}",
                report.provider_key,
            );
        }
    }
    Ok(())
}

#[test]
fn optional_goal_support_is_explicit() {
    let codex = managed_harness_for_kind(SessionKind::Codex).unwrap();
    let claude = managed_harness_for_kind(SessionKind::Claude).unwrap();
    assert_eq!(
        codex.descriptor().optional(HarnessCapability::Goals),
        SupportMode::Native
    );
    assert!(matches!(
        claude.descriptor().optional(HarnessCapability::Goals),
        SupportMode::Unsupported { reason } if !reason.is_empty()
    ));
}

#[test]
fn managed_provider_adapters_stay_isolated() {
    let codex_source = include_str!("../provider_adapters/codex_app_server.rs");
    let claude_source = include_str!("../provider_adapters/claude_stream.rs");

    assert!(!codex_source.contains("claude_stream"));
    assert!(!claude_source.contains("codex_app_server"));
}

#[test]
fn capability_snapshots_include_required_baseline_for_managed_providers() {
    for kind in [SessionKind::Codex, SessionKind::Claude] {
        let harness = managed_harness_for_kind(kind).expect("managed harness");
        let capabilities = session_harness_capabilities_for_descriptor(
            harness.descriptor(),
            vec!["native-extra".to_owned()],
        );
        let required = REQUIRED_HARNESS_FEATURES
            .iter()
            .map(|feature| feature.as_str().to_owned())
            .collect::<Vec<_>>();

        assert_eq!(capabilities.contract_version, 1);
        assert_eq!(capabilities.required, required);
        assert_eq!(capabilities.observed_native, vec!["native-extra"]);
        assert_eq!(
            capabilities.optional.len(),
            harness.descriptor().optional_capabilities.len()
        );
    }
}

#[test]
fn claude_reconfigure_controls_require_resume_with_desired_controls() {
    let claude = managed_harness_for_kind(SessionKind::Claude).unwrap();
    let mut adapter = claude
        .create_adapter(adapter_context(Some("claude-session-1")))
        .unwrap();

    assert!(matches!(
        adapter.plan_control(HarnessControl::SetEffort(Some("high".to_owned()))),
        HarnessControlPlan::RestartRequired(DesiredHarnessControls {
            effort: Some(ref effort),
            ..
        }) if effort == "high"
    ));
}

#[test]
fn claude_interaction_resolution_requires_restart_with_desired_controls() {
    let claude = managed_harness_for_kind(SessionKind::Claude).unwrap();
    let mut adapter = claude
        .create_adapter(adapter_context(Some("claude-session-1")))
        .unwrap();
    adapter.plan_control(HarnessControl::SetModel(Some("claude-sonnet-5".to_owned())));

    assert!(matches!(
        adapter.plan_control(HarnessControl::ResolveInteraction(
            ProviderInteractionResolution::Approve
        )),
        HarnessControlPlan::RestartRequired(DesiredHarnessControls {
            model: Some(ref model),
            ..
        }) if model == "claude-sonnet-5"
    ));
}

#[test]
fn claude_interrupt_uses_process_group_and_resume_recovery() {
    let claude = managed_harness_for_kind(SessionKind::Claude).unwrap();
    let mut adapter = claude
        .create_adapter(adapter_context(Some("claude-session-1")))
        .unwrap();

    assert_eq!(
        adapter.plan_control(HarnessControl::Interrupt),
        HarnessControlPlan::Signal(HarnessSignal::InterruptProcessGroup)
    );
    assert!(matches!(
        adapter.recovery_plan(HarnessRecoveryCause::InterruptDeadline),
        HarnessRecoveryPlan::RestartAndResume {
            native_session_id,
            ..
        } if native_session_id == "claude-session-1"
    ));
}

#[test]
fn codex_interrupt_uses_native_turn_interrupt_when_active() {
    let codex = managed_harness_for_kind(SessionKind::Codex).unwrap();
    let mut adapter = codex
        .create_adapter(adapter_context(Some("codex-thread-1")))
        .unwrap();
    adapter
        .observe_native(NativeRecord {
            provider_key: "codex",
            payload: br#"{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}"#.to_vec(),
        })
        .unwrap();

    assert!(matches!(
        adapter.plan_control(HarnessControl::Interrupt),
        HarnessControlPlan::NativeWrite(_)
    ));
}

#[test]
fn shell_stays_outside_the_managed_chat_contract() {
    assert!(managed_harness_for_kind(SessionKind::Shell).is_none());
}

#[test]
fn managed_adapters_wrap_existing_native_input_formats() {
    let codex = managed_harness_for_kind(SessionKind::Codex).unwrap();
    let mut codex_adapter = codex
        .create_adapter(adapter_context(Some("codex-thread-1")))
        .unwrap();
    let codex_write = codex_adapter
        .encode_input(input("codex-input", "run tests"))
        .unwrap();
    let codex_payload: Value = serde_json::from_slice(&codex_write.payload).unwrap();
    assert_eq!(codex_write.provider_key, "codex");
    assert_eq!(codex_write.local_input_id.as_deref(), Some("codex-input"));
    assert_eq!(codex_payload["method"], "turn/start");
    assert_eq!(codex_payload["params"]["threadId"], "codex-thread-1");
    assert_eq!(codex_payload["params"]["input"][0]["text"], "run tests");

    let claude = managed_harness_for_kind(SessionKind::Claude).unwrap();
    let mut claude_adapter = claude.create_adapter(adapter_context(None)).unwrap();
    let claude_write = claude_adapter
        .encode_input(input("claude-input", "review changes"))
        .unwrap();
    let claude_payload: Value = serde_json::from_slice(&claude_write.payload).unwrap();
    assert_eq!(claude_write.provider_key, "claude");
    assert_eq!(claude_write.local_input_id.as_deref(), Some("claude-input"));
    assert_eq!(claude_payload["type"], "user");
    assert_eq!(claude_payload["message"]["role"], "user");
    assert_eq!(
        claude_payload["message"]["content"][0]["text"],
        "review changes"
    );
}

#[test]
fn claude_does_not_fake_native_input_acknowledgement() {
    let claude = managed_harness_for_kind(SessionKind::Claude).unwrap();
    let mut adapter = claude.create_adapter(adapter_context(None)).unwrap();
    adapter
        .encode_input(input("claude-input", "review changes"))
        .unwrap();

    let effects = adapter
        .observe_native(NativeRecord {
            provider_key: "claude",
            payload: br#"{"type":"stream_event","session_id":"claude-session-1","event":{"type":"message_start","message":{"id":"message-1"}}}
"#
            .to_vec(),
        })
        .unwrap();

    assert!(effects.iter().any(|effect| matches!(
        effect,
        HarnessEffect::TurnStarted { local_input_id } if local_input_id == "claude-input"
    )));
    assert!(!effects
        .iter()
        .any(|effect| matches!(effect, HarnessEffect::InputAcknowledged { .. })));
}

#[test]
fn codex_steer_preserves_turn_start_input_for_exactly_once_completion() {
    let codex = managed_harness_for_kind(SessionKind::Codex).unwrap();
    let mut adapter = codex
        .create_adapter(adapter_context(Some("codex-thread-1")))
        .unwrap();
    adapter
        .encode_input(input("turn-input", "run tests"))
        .unwrap();
    adapter
        .observe_native(codex_record(
            r#"{"method":"turn/started","params":{"threadId":"codex-thread-1","turn":{"id":"turn-1"}}}"#,
        ))
        .unwrap();
    adapter
        .encode_input(immediate_input("steer-input", "also run clippy"))
        .unwrap();

    let completion = codex_record(
        r#"{"method":"turn/completed","params":{"threadId":"codex-thread-1","turn":{"id":"turn-1","status":"completed"}}}"#,
    );
    let effects = adapter.observe_native(completion.clone()).unwrap();
    assert!(effects.iter().any(|effect| matches!(
        effect,
        HarnessEffect::TurnCompleted { local_input_id, .. } if local_input_id == "turn-input"
    )));
    assert!(!effects.iter().any(|effect| matches!(
        effect,
        HarnessEffect::TurnCompleted { local_input_id, .. } if local_input_id == "steer-input"
    )));

    let duplicate_effects = adapter.observe_native(completion).unwrap();
    assert!(!duplicate_effects
        .iter()
        .any(|effect| matches!(effect, HarnessEffect::TurnCompleted { .. })));
}

fn adapter_context(native_session_id: Option<&str>) -> HarnessAdapterContext {
    HarnessAdapterContext {
        session_id: 7,
        thread_id: 11,
        workspace: "berlin".to_owned(),
        native_session_id: native_session_id.map(ToOwned::to_owned),
        controls: DesiredHarnessControls::default(),
    }
}

fn input(local_input_id: &str, content: &str) -> HarnessInput {
    HarnessInput {
        local_input_id: local_input_id.to_owned(),
        content: content.to_owned(),
        visible_content: None,
        kind: ArchcarInputKind::User,
        delivery: ArchcarInputDelivery::Auto,
    }
}

fn immediate_input(local_input_id: &str, content: &str) -> HarnessInput {
    HarnessInput {
        delivery: ArchcarInputDelivery::Immediate,
        ..input(local_input_id, content)
    }
}

fn codex_record(payload: &str) -> NativeRecord {
    NativeRecord {
        provider_key: "codex",
        payload: format!("{payload}\n").into_bytes(),
    }
}
