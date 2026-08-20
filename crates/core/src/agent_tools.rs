#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolId {
    Codex,
    Claude,
    Gemini,
    OpenCode,
    Aider,
    Amp,
    Copilot,
    CursorAgent,
    Grok,
    Cursor,
    VsCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    ChatAgent,
    Editor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchOwner {
    ArchcarManaged,
    LocalWorkspace,
    NotSupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolSpec {
    pub id: ToolId,
    pub provider_key: &'static str,
    pub display_name: &'static str,
    pub default_command: &'static str,
    pub aliases: &'static [&'static str],
    pub kind: ToolKind,
    pub chat_launchable: bool,
    pub launch_owner: LaunchOwner,
    pub readiness_probe: &'static [&'static str],
    pub auth_guidance: &'static str,
    /// Flags that put the agent into Agent Client Protocol mode. Non-empty
    /// means this build can drive it as a managed session through the shared
    /// ACP adapter instead of a bare PTY.
    pub acp_args: &'static [&'static str],
}

impl ToolSpec {
    pub fn speaks_acp(&self) -> bool {
        !self.acp_args.is_empty()
    }
}

const TOOL_SPECS: &[ToolSpec] = &[
    ToolSpec {
        id: ToolId::Codex,
        provider_key: "codex",
        display_name: "Codex",
        default_command: "codex",
        aliases: &["codex"],
        kind: ToolKind::ChatAgent,
        chat_launchable: true,
        launch_owner: LaunchOwner::ArchcarManaged,
        readiness_probe: &["codex", "login", "status"],
        auth_guidance: "Run `codex login`.",
        acp_args: &[],
    },
    ToolSpec {
        id: ToolId::Claude,
        provider_key: "claude",
        display_name: "Claude Code",
        default_command: "claude",
        aliases: &["claude", "claudecode", "claude-code"],
        kind: ToolKind::ChatAgent,
        chat_launchable: true,
        launch_owner: LaunchOwner::ArchcarManaged,
        readiness_probe: &["claude", "auth", "status"],
        auth_guidance: "Run `claude auth login`.",
        acp_args: &[],
    },
    ToolSpec {
        id: ToolId::Gemini,
        provider_key: "gemini",
        display_name: "Gemini CLI",
        default_command: "gemini",
        aliases: &["gemini", "gemini-cli", "geminicli"],
        kind: ToolKind::ChatAgent,
        chat_launchable: true,
        launch_owner: LaunchOwner::ArchcarManaged,
        readiness_probe: &["gemini", "--version"],
        auth_guidance: "Run `gemini` once to sign in.",
        acp_args: &["--experimental-acp"],
    },
    ToolSpec {
        id: ToolId::OpenCode,
        provider_key: "opencode",
        display_name: "OpenCode",
        default_command: "opencode",
        aliases: &["opencode", "open-code"],
        kind: ToolKind::ChatAgent,
        chat_launchable: false,
        launch_owner: LaunchOwner::NotSupported,
        readiness_probe: &["opencode", "--version"],
        auth_guidance: "Install and configure OpenCode.",
        acp_args: &[],
    },
    ToolSpec {
        id: ToolId::Aider,
        provider_key: "aider",
        display_name: "Aider",
        default_command: "aider",
        aliases: &["aider", "aider-chat"],
        kind: ToolKind::ChatAgent,
        chat_launchable: false,
        launch_owner: LaunchOwner::NotSupported,
        readiness_probe: &["aider", "--version"],
        auth_guidance: "Install Aider (`pipx install aider-chat`) and set a model API key.",
        acp_args: &[],
    },
    ToolSpec {
        id: ToolId::Amp,
        provider_key: "amp",
        display_name: "Amp",
        default_command: "amp",
        aliases: &["amp", "ampcode"],
        kind: ToolKind::ChatAgent,
        chat_launchable: false,
        launch_owner: LaunchOwner::NotSupported,
        readiness_probe: &["amp", "--version"],
        auth_guidance: "Run `amp login`.",
        acp_args: &[],
    },
    ToolSpec {
        id: ToolId::Copilot,
        provider_key: "copilot",
        display_name: "GitHub Copilot CLI",
        default_command: "copilot",
        aliases: &["copilot", "github-copilot", "copilot-cli"],
        kind: ToolKind::ChatAgent,
        chat_launchable: false,
        launch_owner: LaunchOwner::NotSupported,
        readiness_probe: &["copilot", "--version"],
        auth_guidance: "Authenticate GitHub CLI and enable Copilot for your account.",
        acp_args: &[],
    },
    ToolSpec {
        id: ToolId::CursorAgent,
        provider_key: "cursor-agent",
        display_name: "Cursor Agent",
        default_command: "cursor-agent",
        aliases: &["cursoragent", "cursor-agent"],
        kind: ToolKind::ChatAgent,
        chat_launchable: false,
        launch_owner: LaunchOwner::NotSupported,
        readiness_probe: &["cursor-agent", "--version"],
        auth_guidance: "Run `cursor-agent login`.",
        acp_args: &[],
    },
    ToolSpec {
        id: ToolId::Grok,
        provider_key: "grok",
        display_name: "Grok CLI",
        default_command: "grok",
        aliases: &["grok", "grok-cli"],
        kind: ToolKind::ChatAgent,
        chat_launchable: false,
        launch_owner: LaunchOwner::NotSupported,
        readiness_probe: &["grok", "--version"],
        auth_guidance: "Set `XAI_API_KEY` or run `grok login`.",
        acp_args: &[],
    },
    ToolSpec {
        id: ToolId::Cursor,
        provider_key: "cursor",
        display_name: "Cursor",
        default_command: "cursor",
        aliases: &["cursor"],
        kind: ToolKind::Editor,
        chat_launchable: false,
        launch_owner: LaunchOwner::NotSupported,
        readiness_probe: &["cursor", "--version"],
        auth_guidance: "Install Cursor.",
        acp_args: &[],
    },
    ToolSpec {
        id: ToolId::VsCode,
        provider_key: "vscode",
        display_name: "VS Code",
        default_command: "code",
        aliases: &["vscode", "vs-code", "code"],
        kind: ToolKind::Editor,
        chat_launchable: false,
        launch_owner: LaunchOwner::NotSupported,
        readiness_probe: &["code", "--version"],
        auth_guidance: "Install VS Code.",
        acp_args: &[],
    },
];

pub fn all_tools() -> &'static [ToolSpec] {
    TOOL_SPECS
}

pub fn agent_tools() -> impl Iterator<Item = &'static ToolSpec> {
    TOOL_SPECS
        .iter()
        .filter(|tool| tool.kind == ToolKind::ChatAgent)
}

pub fn launchable_agent_tools() -> impl Iterator<Item = &'static ToolSpec> {
    agent_tools()
        .filter(|tool| tool.chat_launchable && tool.launch_owner != LaunchOwner::NotSupported)
}

pub fn tool_by_provider(provider: &str) -> Option<&'static ToolSpec> {
    let normalized = normalize_provider_key(provider);
    TOOL_SPECS.iter().find(|tool| {
        normalize_provider_key(tool.provider_key) == normalized
            || tool
                .aliases
                .iter()
                .any(|alias| normalize_provider_key(alias) == normalized)
    })
}

pub fn canonical_provider_key(provider: &str) -> Option<&'static str> {
    tool_by_provider(provider).map(|tool| tool.provider_key)
}

pub fn launchable_provider_key(provider: &str) -> Option<&'static str> {
    tool_by_provider(provider)
        .filter(|tool| tool.chat_launchable)
        .map(|tool| tool.provider_key)
}

pub fn supported_agent_provider_key(provider: &str) -> Option<&'static str> {
    tool_by_provider(provider)
        .filter(|tool| tool.kind == ToolKind::ChatAgent)
        .map(|tool| tool.provider_key)
}

pub fn normalize_provider_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_marks_codex_and_claude_as_launchable_chat_agents() {
        let launchable = launchable_agent_tools()
            .map(|tool| tool.provider_key)
            .collect::<Vec<_>>();

        // Gemini joins them through the shared ACP adapter rather than a
        // vendor-specific one.
        assert_eq!(launchable, ["codex", "claude", "gemini"]);
        assert!(
            launchable_agent_tools().all(|tool| tool.launch_owner == LaunchOwner::ArchcarManaged)
        );
    }

    #[test]
    fn registry_keeps_opencode_detectable_but_not_launchable() {
        let opencode = tool_by_provider("open-code").unwrap();

        assert_eq!(opencode.provider_key, "opencode");
        assert_eq!(supported_agent_provider_key("opencode"), Some("opencode"));
        assert_eq!(launchable_provider_key("opencode"), None);
    }

    /// ACP support is a registry fact, so adding an ACP-speaking agent needs no
    /// adapter code at all.
    #[test]
    fn only_agents_with_acp_flags_are_driven_over_acp() {
        assert!(tool_by_provider("gemini").unwrap().speaks_acp());
        assert_eq!(
            tool_by_provider("gemini").unwrap().acp_args,
            ["--experimental-acp"]
        );
        assert!(!tool_by_provider("codex").unwrap().speaks_acp());
        assert!(!tool_by_provider("aider").unwrap().speaks_acp());
    }

    #[test]
    fn registry_normalizes_claude_code_aliases() {
        assert_eq!(canonical_provider_key("Claude Code"), Some("claude"));
        assert_eq!(launchable_provider_key("claude-code"), Some("claude"));
    }
}
