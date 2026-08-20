use anyhow::Result;

use crate::archcar::harness_contract::{
    ManagedHarness, CORE_HARNESS_FEATURES, EXTENDED_HARNESS_FEATURES,
    MANAGED_HARNESS_CONTRACT_VERSION,
};
use crate::workspace::{SessionHarnessOptions, SessionKind, WorkspaceStore};

pub trait HarnessController: Send + Sync {
    fn kind(&self) -> SessionKind;
    fn supports_auto_spawn(&self) -> bool;
    fn build_launch(
        &self,
        store: &WorkspaceStore,
        workspace: &str,
        harness: SessionHarnessOptions,
    ) -> Result<crate::workspace::SessionLaunch>;
}

pub fn controller_for_kind(kind: SessionKind) -> Box<dyn HarnessController> {
    match kind {
        SessionKind::CODEX => Box::new(CodexHarnessController),
        SessionKind::CLAUDE => Box::new(ClaudeHarnessController),
        SessionKind::SHELL => Box::new(ShellHarnessController),
        other if speaks_acp(other) => Box::new(AcpHarnessController(other)),
        // Any other registered agent launches from its registry entry. It runs
        // in a PTY with no structured transport until an adapter claims it, so
        // it behaves like a terminal that happens to have an agent in it.
        other => Box::new(RegistryHarnessController(other)),
    }
}

/// `None` means "drive this as a plain PTY". Shell is never managed, and a
/// registered agent is only managed once an adapter exists for it — a
/// descriptor is a promise about behaviour, so one is not invented here.
pub fn managed_harness_for_kind(kind: SessionKind) -> Option<Box<dyn ManagedHarness>> {
    match kind {
        SessionKind::CODEX => Some(Box::new(CodexHarnessController)),
        SessionKind::CLAUDE => Some(Box::new(ClaudeHarnessController)),
        // Any ACP-speaking agent is managed through the one shared adapter, so
        // provider breadth costs a registry entry rather than a new module.
        other if speaks_acp(other) => Some(Box::new(AcpHarnessController(other))),
        _ => None,
    }
}

fn speaks_acp(kind: SessionKind) -> bool {
    crate::agent_tools::tool_by_provider(kind.as_str()).is_some_and(|tool| tool.speaks_acp())
}

/// Drives any registered ACP agent. The provider varies; the protocol does not,
/// which is the whole point.
pub struct AcpHarnessController(SessionKind);

impl HarnessController for AcpHarnessController {
    fn kind(&self) -> SessionKind {
        self.0
    }

    fn supports_auto_spawn(&self) -> bool {
        true
    }

    fn build_launch(
        &self,
        store: &WorkspaceStore,
        workspace: &str,
        harness: SessionHarnessOptions,
    ) -> Result<crate::workspace::SessionLaunch> {
        store.session_launch_with_options(workspace, self.0, harness)
    }
}

impl ManagedHarness for AcpHarnessController {
    fn descriptor(&self) -> &'static crate::archcar::harness_contract::HarnessDescriptor {
        crate::provider_adapters::acp::descriptor_for(self.0)
    }

    fn create_adapter(
        &self,
        context: crate::archcar::harness_contract::HarnessAdapterContext,
    ) -> Result<Box<dyn crate::archcar::harness_contract::ManagedHarnessAdapter>> {
        Ok(Box::new(crate::provider_adapters::acp::AcpAdapter::new(
            self.0, &context,
        )))
    }
}

/// Display name from the registry, falling back to the raw key so an
/// unregistered provider still renders as something a person can read.
pub fn display_name_for_kind(kind: SessionKind) -> &'static str {
    kind.display_name()
}

/// Launches a registry-listed agent with no managed transport. `build_launch`
/// resolves the executable from the registry rather than a hardcoded match.
pub struct RegistryHarnessController(SessionKind);

impl HarnessController for RegistryHarnessController {
    fn kind(&self) -> SessionKind {
        self.0
    }

    fn supports_auto_spawn(&self) -> bool {
        // Without a readiness signal there is nothing to wait for before
        // delivering queued input, so these are started explicitly.
        false
    }

    fn build_launch(
        &self,
        store: &WorkspaceStore,
        workspace: &str,
        harness: SessionHarnessOptions,
    ) -> Result<crate::workspace::SessionLaunch> {
        store.session_launch_with_options(workspace, self.0, harness)
    }
}

pub fn validate_managed_harness(harness: &dyn ManagedHarness) -> Result<()> {
    let descriptor = harness.descriptor();
    anyhow::ensure!(
        descriptor.contract_version == MANAGED_HARNESS_CONTRACT_VERSION,
        "{} uses managed harness contract {} instead of {}",
        descriptor.provider_key,
        descriptor.contract_version,
        MANAGED_HARNESS_CONTRACT_VERSION,
    );
    anyhow::ensure!(
        descriptor.core_features == CORE_HARNESS_FEATURES,
        "{} does not declare the complete core harness baseline",
        descriptor.provider_key,
    );
    // Every extended feature needs a written verdict. An omission would read as
    // unsupported at runtime, which is indistinguishable from a deliberate
    // `Unsupported` — and one of those is a decision while the other is a bug.
    for feature in EXTENDED_HARNESS_FEATURES {
        anyhow::ensure!(
            descriptor
                .extended_features
                .iter()
                .any(|(candidate, _)| candidate == feature),
            "{} does not declare support for {}",
            descriptor.provider_key,
            feature.as_str(),
        );
    }
    for (feature, _) in descriptor.extended_features {
        anyhow::ensure!(
            EXTENDED_HARNESS_FEATURES.contains(feature),
            "{} declares {} as extended, but it is not an extended feature",
            descriptor.provider_key,
            feature.as_str(),
        );
    }
    Ok(())
}

pub struct CodexHarnessController;

impl HarnessController for CodexHarnessController {
    fn kind(&self) -> SessionKind {
        SessionKind::CODEX
    }

    fn supports_auto_spawn(&self) -> bool {
        true
    }

    fn build_launch(
        &self,
        store: &WorkspaceStore,
        workspace: &str,
        harness: SessionHarnessOptions,
    ) -> Result<crate::workspace::SessionLaunch> {
        store.session_launch_with_options(workspace, SessionKind::CODEX, harness)
    }
}

pub struct ClaudeHarnessController;

impl HarnessController for ClaudeHarnessController {
    fn kind(&self) -> SessionKind {
        SessionKind::CLAUDE
    }

    fn supports_auto_spawn(&self) -> bool {
        true
    }

    fn build_launch(
        &self,
        store: &WorkspaceStore,
        workspace: &str,
        harness: SessionHarnessOptions,
    ) -> Result<crate::workspace::SessionLaunch> {
        store.session_launch_with_options(workspace, SessionKind::CLAUDE, harness)
    }
}

pub struct ShellHarnessController;

impl HarnessController for ShellHarnessController {
    fn kind(&self) -> SessionKind {
        SessionKind::SHELL
    }

    fn supports_auto_spawn(&self) -> bool {
        false
    }

    fn build_launch(
        &self,
        store: &WorkspaceStore,
        workspace: &str,
        harness: SessionHarnessOptions,
    ) -> Result<crate::workspace::SessionLaunch> {
        store.session_launch_with_options(workspace, SessionKind::SHELL, harness)
    }
}

pub fn provider_name(kind: SessionKind) -> &'static str {
    kind.as_str()
}

pub fn ensure_thread_for_kind(
    store: &WorkspaceStore,
    workspace: &str,
    kind: SessionKind,
) -> Result<crate::workspace::ChatThreadRecord> {
    let provider = provider_name(kind);
    if let Some(existing) = store
        .list_chat_threads(workspace)?
        .into_iter()
        .find(|thread| thread.provider == provider)
    {
        return Ok(existing);
    }
    // Title from the registry so a newly registered agent reads as
    // "Gemini CLI Chat 1" rather than falling back to its bare key.
    let title = format!("{} Chat 1", display_name_for_kind(kind));
    store.create_chat_thread(workspace, provider, &title, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::{AddRepository, RepositoryStore};
    use crate::workspace::CreateWorkspace;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    #[test]
    fn codex_harness_reports_runtime_capabilities_without_screen_hooks() {
        let controller = CodexHarnessController;
        assert_eq!(controller.kind(), SessionKind::CODEX);
        assert!(controller.supports_auto_spawn());
    }

    /// A registered agent with no adapter still resolves to a controller and
    /// launches from its registry command, rather than failing to dispatch.
    #[test]
    fn registered_agents_without_an_adapter_fall_back_to_a_pty_controller() {
        let aider = SessionKind::new("aider");
        let controller = controller_for_kind(aider);

        assert_eq!(controller.kind(), aider);
        // No readiness signal means nothing to wait on before draining input.
        assert!(!controller.supports_auto_spawn());
        // And crucially, no descriptor is invented for it.
        assert!(managed_harness_for_kind(aider).is_none());
        assert_eq!(aider.display_name(), "Aider");
    }

    /// The payoff of the shared adapter: an agent nobody wrote code for is
    /// managed purely because the registry says it speaks ACP.
    #[test]
    fn acp_agents_are_managed_without_a_dedicated_adapter() {
        let gemini = SessionKind::new("gemini");
        let harness = managed_harness_for_kind(gemini).expect("gemini is managed over ACP");

        assert_eq!(harness.descriptor().provider_key, "gemini");
        validate_managed_harness(harness.as_ref()).expect("valid ACP descriptor");
        assert!(controller_for_kind(gemini).supports_auto_spawn());
    }

    /// Provider identity is open, but launching still requires registration —
    /// otherwise there is no command to run.
    #[test]
    fn an_unregistered_provider_has_an_identity_but_no_launch_command() {
        let unknown = SessionKind::new("not-a-real-agent");

        assert_eq!(unknown.as_str(), "not-a-real-agent");
        assert!(managed_harness_for_kind(unknown).is_none());
        // Falls back to the key so logs stay readable.
        assert_eq!(unknown.display_name(), "not-a-real-agent");
    }

    #[test]
    fn managed_harness_registry_validates_codex_and_claude_baseline() {
        for kind in [SessionKind::CODEX, SessionKind::CLAUDE] {
            let harness = managed_harness_for_kind(kind).unwrap();
            validate_managed_harness(harness.as_ref()).unwrap();
        }
        assert!(managed_harness_for_kind(SessionKind::SHELL).is_none());
    }

    #[test]
    fn claude_harness_reports_runtime_capabilities() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("test.db");
        let repo_path = init_repo(temp.path().join("demo"));
        RepositoryStore::open(&db)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo_path,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(temp.path().join("workspaces/demo")),
            })
            .unwrap();
        let store = WorkspaceStore::open(&db).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        let controller = ClaudeHarnessController;

        assert_eq!(controller.kind(), SessionKind::CLAUDE);
        assert!(controller.supports_auto_spawn());
        let launch = controller
            .build_launch(&store, "berlin", SessionHarnessOptions::default())
            .unwrap();
        assert_eq!(launch.kind, SessionKind::CLAUDE);
        assert_eq!(launch.program, PathBuf::from("claude"));
        assert!(launch.session_resume_id.is_some());
        assert_eq!(
            launch.args,
            vec![
                "--permission-mode".to_owned(),
                "bypassPermissions".to_owned(),
                "--dangerously-skip-permissions".to_owned(),
                "--session-id".to_owned(),
                launch.session_resume_id.as_deref().unwrap().to_owned(),
                "--append-system-prompt".to_owned(),
                "[archductor bootstrap for claude]\napproval mode: never".to_owned(),
            ]
        );
        assert!(launch.cwd.ends_with("berlin"));
    }

    fn init_repo(path: PathBuf) -> PathBuf {
        fs::create_dir(&path).unwrap();
        assert!(
            Command::new("git")
                .args(["init", "--initial-branch", "main"])
                .arg(&path)
                .status()
                .unwrap()
                .success(),
            "git init fixture repo"
        );
        fs::write(path.join("README.md"), "demo\n").unwrap();
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&path)
                .args(["add", "."])
                .status()
                .unwrap()
                .success(),
            "git add fixture repo"
        );
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&path)
                .args([
                    "-c",
                    "user.name=Archductor",
                    "-c",
                    "user.email=archductor@example.test",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-m",
                    "initial",
                ])
                .status()
                .unwrap()
                .success(),
            "git commit fixture repo"
        );
        path
    }
}
