use crate::archcar::harness::HarnessController;
use crate::archcar::protocol::{ArchcarInputDelivery, ArchcarInputKind};
use crate::provider_events::ProviderEventDraft;
use crate::workspace::SessionKind;
use serde::{Deserialize, Serialize};

pub const MANAGED_HARNESS_CONTRACT_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum HarnessFeature {
    Preflight,
    ThreadScopedSession,
    ProcessLifecycle,
    InputDelivery,
    InputAcknowledgement,
    StreamingEvents,
    ExactlyOnceTurnCompletion,
    Queueing,
    Interrupt,
    Resume,
    CrashRecovery,
    SessionControls,
    ProviderInteractions,
    StructuredErrors,
    CapabilityDiscovery,
}

impl HarnessFeature {
    pub fn as_str(self) -> &'static str {
        match self {
            HarnessFeature::Preflight => "preflight",
            HarnessFeature::ThreadScopedSession => "thread_scoped_session",
            HarnessFeature::ProcessLifecycle => "process_lifecycle",
            HarnessFeature::InputDelivery => "input_delivery",
            HarnessFeature::InputAcknowledgement => "input_acknowledgement",
            HarnessFeature::StreamingEvents => "streaming_events",
            HarnessFeature::ExactlyOnceTurnCompletion => "exactly_once_turn_completion",
            HarnessFeature::Queueing => "queueing",
            HarnessFeature::Interrupt => "interrupt",
            HarnessFeature::Resume => "resume",
            HarnessFeature::CrashRecovery => "crash_recovery",
            HarnessFeature::SessionControls => "session_controls",
            HarnessFeature::ProviderInteractions => "provider_interactions",
            HarnessFeature::StructuredErrors => "structured_errors",
            HarnessFeature::CapabilityDiscovery => "capability_discovery",
        }
    }
}

/// The floor. Every managed harness — Codex, an ACP agent, a bare PTY
/// passthrough — must implement all of these natively, because the daemon
/// cannot fake any of them: it has to be able to check the tool is installed,
/// own the process, hand it input, stream something back, know when a turn is
/// over, report failure in a structured way, and say what it supports.
pub const CORE_HARNESS_FEATURES: &[HarnessFeature] = &[
    HarnessFeature::Preflight,
    HarnessFeature::ProcessLifecycle,
    HarnessFeature::InputDelivery,
    HarnessFeature::StreamingEvents,
    HarnessFeature::ExactlyOnceTurnCompletion,
    HarnessFeature::StructuredErrors,
    HarnessFeature::CapabilityDiscovery,
];

/// Declared per provider with a [`SupportMode`]. A descriptor must carry an
/// entry for every one of these — `Unsupported { reason }` is a valid answer,
/// silence is not — so a capability gap is always a written statement rather
/// than an omission nobody noticed.
pub const EXTENDED_HARNESS_FEATURES: &[HarnessFeature] = &[
    HarnessFeature::ThreadScopedSession,
    HarnessFeature::InputAcknowledgement,
    HarnessFeature::Queueing,
    HarnessFeature::Interrupt,
    HarnessFeature::Resume,
    HarnessFeature::CrashRecovery,
    HarnessFeature::SessionControls,
    HarnessFeature::ProviderInteractions,
];

pub const ALL_HARNESS_FEATURES: &[HarnessFeature] = &[
    HarnessFeature::Preflight,
    HarnessFeature::ThreadScopedSession,
    HarnessFeature::ProcessLifecycle,
    HarnessFeature::InputDelivery,
    HarnessFeature::InputAcknowledgement,
    HarnessFeature::StreamingEvents,
    HarnessFeature::ExactlyOnceTurnCompletion,
    HarnessFeature::Queueing,
    HarnessFeature::Interrupt,
    HarnessFeature::Resume,
    HarnessFeature::CrashRecovery,
    HarnessFeature::SessionControls,
    HarnessFeature::ProviderInteractions,
    HarnessFeature::StructuredErrors,
    HarnessFeature::CapabilityDiscovery,
];

/// How complete a provider's support is. Derived from the descriptor's
/// extended-feature declarations rather than stored, so it cannot drift away
/// from what the adapter actually does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum HarnessTier {
    /// Every extended feature works, natively or through an honest emulation.
    Full,
    /// Some extended features work; the rest are declared unsupported.
    Partial,
    /// Core only. Launches and streams, nothing more.
    Basic,
}

impl HarnessTier {
    pub fn as_str(self) -> &'static str {
        match self {
            HarnessTier::Full => "full",
            HarnessTier::Partial => "partial",
            HarnessTier::Basic => "basic",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HarnessCapability {
    Goals,
    NativeSlashCommands,
}

impl HarnessCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            HarnessCapability::Goals => "goals",
            HarnessCapability::NativeSlashCommands => "native_slash_commands",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupportMode {
    Native,
    RestartRequired,
    Emulated,
    Unsupported { reason: &'static str },
}

impl SupportMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            SupportMode::Native => "native",
            SupportMode::RestartRequired => "restart_required",
            SupportMode::Emulated => "emulated",
            SupportMode::Unsupported { .. } => "unsupported",
        }
    }

    pub fn reason(&self) -> Option<&'static str> {
        match self {
            SupportMode::Unsupported { reason } => Some(reason),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessDescriptor {
    pub contract_version: u16,
    pub kind: SessionKind,
    pub provider_key: &'static str,
    pub display_name: &'static str,
    pub default_executable: &'static str,
    pub preflight: HarnessPreflightSpec,
    pub core_features: &'static [HarnessFeature],
    pub extended_features: &'static [(HarnessFeature, SupportMode)],
    pub optional_capabilities: &'static [(HarnessCapability, SupportMode)],
}

impl HarnessDescriptor {
    pub fn optional(&self, capability: HarnessCapability) -> SupportMode {
        self.optional_capabilities
            .iter()
            .find_map(|(candidate, support)| (*candidate == capability).then(|| support.clone()))
            .unwrap_or(SupportMode::Unsupported {
                reason: "capability is not declared by this harness",
            })
    }

    /// An undeclared extended feature reads as unsupported rather than
    /// panicking; `validate_managed_harness` is what refuses to register a
    /// descriptor with gaps.
    pub fn extended(&self, feature: HarnessFeature) -> SupportMode {
        self.extended_features
            .iter()
            .find_map(|(candidate, support)| (*candidate == feature).then(|| support.clone()))
            .unwrap_or(SupportMode::Unsupported {
                reason: "feature is not declared by this harness",
            })
    }

    pub fn supports(&self, feature: HarnessFeature) -> bool {
        if self.core_features.contains(&feature) {
            return true;
        }
        !matches!(self.extended(feature), SupportMode::Unsupported { .. })
    }

    pub fn tier(&self) -> HarnessTier {
        let supported = EXTENDED_HARNESS_FEATURES
            .iter()
            .filter(|feature| !matches!(self.extended(**feature), SupportMode::Unsupported { .. }))
            .count();
        match supported {
            0 => HarnessTier::Basic,
            count if count == EXTENDED_HARNESS_FEATURES.len() => HarnessTier::Full,
            _ => HarnessTier::Partial,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessInput {
    pub local_input_id: String,
    pub content: String,
    pub visible_content: Option<String>,
    pub kind: ArchcarInputKind,
    pub delivery: ArchcarInputDelivery,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeWrite {
    pub provider_key: &'static str,
    pub local_input_id: Option<String>,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeRecord {
    pub provider_key: &'static str,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HarnessPreflightSpec {
    pub command: &'static [&'static str],
    pub auth_guidance: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessAdapterContext {
    pub session_id: i64,
    pub thread_id: i64,
    pub workspace: String,
    pub native_session_id: Option<String>,
    pub controls: DesiredHarnessControls,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DesiredHarnessControls {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub fast_mode: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessTurnStatus {
    Success,
    Failed,
    Interrupted,
    Deferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessSignal {
    InterruptProcessGroup,
    TerminateProcessGroup,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessRecoveryCause {
    ChildExited(Option<i32>),
    ProtocolError(String),
    InterruptDeadline,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessRecoveryPlan {
    Continue,
    RestartAndResume {
        native_session_id: String,
        controls: DesiredHarnessControls,
    },
    Fail {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderInteractionKind {
    Permission,
    UserQuestion,
    PlanApproval,
}

/// One selectable answer for an interaction question. Both providers describe
/// options as a short label plus a longer description.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractionOption {
    pub label: String,
    pub description: String,
}

/// One question inside an interaction. Providers ask in batches (codex's
/// `item/tool/requestUserInput`, Claude's `AskUserQuestion`), each question
/// carrying its own options, so a flat choice list cannot represent them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractionQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<InteractionOption>,
    /// The asker accepts free text beyond the listed options.
    pub allow_other: bool,
    /// More than one option may be chosen.
    pub multi_select: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractionAnswer {
    pub question_id: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderInteractionDraft {
    pub provider_key: String,
    pub workspace: String,
    pub thread_id: i64,
    pub session_id: i64,
    pub native_session_id: Option<String>,
    pub native_id: String,
    pub kind: ProviderInteractionKind,
    pub title: String,
    pub detail: String,
    pub questions: Vec<InteractionQuestion>,
    /// How long the provider will wait before resolving the ask itself
    /// (codex's `autoResolutionMs`). `None` means it waits indefinitely.
    pub auto_resolution_ms: Option<u64>,
    pub native_request: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProviderInteractionResolution {
    Approve,
    ApproveForSession,
    Deny { reason: Option<String> },
    Answer { answers: Vec<InteractionAnswer> },
    Defer,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HarnessEffect {
    Initialized {
        native_session_id: String,
        model: Option<String>,
    },
    Ready,
    InputAcknowledged {
        local_input_id: String,
    },
    TurnStarted {
        local_input_id: String,
    },
    TurnCompleted {
        local_input_id: String,
        status: HarnessTurnStatus,
    },
    TurnSettled {
        status: HarnessTurnStatus,
    },
    ProviderEvent(ProviderEventDraft),
    InteractionRequested(ProviderInteractionDraft),
    InteractionResolved {
        interaction_id: String,
    },
    CapabilitiesObserved(Vec<String>),
    Retry {
        message: String,
        delay_ms: Option<u64>,
    },
    RateLimited {
        message: String,
        retry_after_ms: Option<u64>,
    },
    Warning(String),
    Fatal(String),
    ResumeRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessControl {
    Interrupt,
    Kill,
    SetModel(Option<String>),
    SetEffort(Option<String>),
    SetFastMode(bool),
    SetPermissionMode(Option<String>),
    ResolveInteraction {
        /// The provider's own id for the ask (JSON-RPC request id for codex,
        /// `control_request.request_id` for Claude) — the answer is worthless
        /// unless it can be correlated back to what was asked.
        native_id: String,
        resolution: ProviderInteractionResolution,
    },
}

#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum HarnessControlPlan {
    NativeWrite(NativeWrite),
    /// Handled inside the adapter with nothing to send: the control changes
    /// how the next request is built rather than producing one now.
    Applied,
    Signal(HarnessSignal),
    RestartRequired(DesiredHarnessControls),
    Emulated(HarnessEffect),
    Unsupported {
        reason: String,
    },
}

pub trait ManagedHarness: HarnessController {
    fn descriptor(&self) -> &'static HarnessDescriptor;
    fn create_adapter(
        &self,
        context: HarnessAdapterContext,
    ) -> anyhow::Result<Box<dyn ManagedHarnessAdapter>>;
}

pub trait ManagedHarnessAdapter: Send {
    fn encode_input(&mut self, input: HarnessInput) -> anyhow::Result<NativeWrite>;
    fn observe_native(&mut self, record: NativeRecord) -> anyhow::Result<Vec<HarnessEffect>>;
    fn plan_control(&mut self, control: HarnessControl) -> HarnessControlPlan;
    fn recovery_plan(&self, cause: HarnessRecoveryCause) -> HarnessRecoveryPlan;
}
