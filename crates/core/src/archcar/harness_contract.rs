use crate::archcar::harness::HarnessController;
use crate::archcar::protocol::{ArchcarInputDelivery, ArchcarInputKind};
use crate::provider_events::ProviderEventDraft;
use crate::workspace::SessionKind;

pub const MANAGED_HARNESS_CONTRACT_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RequiredHarnessFeature {
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

pub const REQUIRED_HARNESS_FEATURES: &[RequiredHarnessFeature] = &[
    RequiredHarnessFeature::Preflight,
    RequiredHarnessFeature::ThreadScopedSession,
    RequiredHarnessFeature::ProcessLifecycle,
    RequiredHarnessFeature::InputDelivery,
    RequiredHarnessFeature::InputAcknowledgement,
    RequiredHarnessFeature::StreamingEvents,
    RequiredHarnessFeature::ExactlyOnceTurnCompletion,
    RequiredHarnessFeature::Queueing,
    RequiredHarnessFeature::Interrupt,
    RequiredHarnessFeature::Resume,
    RequiredHarnessFeature::CrashRecovery,
    RequiredHarnessFeature::SessionControls,
    RequiredHarnessFeature::ProviderInteractions,
    RequiredHarnessFeature::StructuredErrors,
    RequiredHarnessFeature::CapabilityDiscovery,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HarnessCapability {
    Goals,
    NativeSlashCommands,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupportMode {
    Native,
    RestartRequired,
    Emulated,
    Unsupported { reason: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessDescriptor {
    pub contract_version: u16,
    pub kind: SessionKind,
    pub provider_key: &'static str,
    pub display_name: &'static str,
    pub default_executable: &'static str,
    pub preflight: HarnessPreflightSpec,
    pub required_features: &'static [RequiredHarnessFeature],
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderInteractionKind {
    Permission,
    UserQuestion,
    PlanApproval,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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
    pub choices: Vec<String>,
    pub native_request: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderInteractionResolution {
    Approve,
    Deny { reason: Option<String> },
    Answer { answers: Vec<(String, String)> },
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
    SetPermissionMode(Option<String>),
    ResolveInteraction(ProviderInteractionResolution),
}

#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum HarnessControlPlan {
    NativeWrite(NativeWrite),
    Signal(HarnessSignal),
    RestartRequired(DesiredHarnessControls),
    Emulated(HarnessEffect),
    Unsupported { reason: String },
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
