use crate::agent_tools::{
    agent_tools, all_tools, canonical_provider_key, launchable_provider_key, tool_by_provider,
    LaunchOwner, ToolSpec,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependencyCheck {
    pub name: &'static str,
    pub required: bool,
    pub installed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorReport {
    pub distro_id: Option<String>,
    pub distro_like: Vec<String>,
    pub install_command: Option<&'static str>,
    pub dependencies: Vec<DependencyCheck>,
}

/// One agent's readiness, carried alongside the registry facts the setup
/// surfaces need. Keyed by provider rather than held in a named field, so
/// adding an agent to `agent_tools` is the whole change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderReadiness {
    pub provider_key: &'static str,
    pub display_name: &'static str,
    pub launchable: bool,
    pub check: SetupCheck,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupReadiness {
    pub gh: SetupCheck,
    /// One entry per chat agent in the registry, in registry order.
    pub providers: Vec<ProviderReadiness>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupBlocker {
    GithubUnavailable,
    MissingAgent,
    SelectedProviderUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupCheck {
    pub installed: bool,
    pub ready: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeCliStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub version: Option<(u16, u16, u16)>,
    pub supported: bool,
    pub detail: String,
}

impl SetupCheck {
    pub fn missing(detail: impl Into<String>) -> Self {
        Self {
            installed: false,
            ready: false,
            detail: detail.into(),
        }
    }

    pub fn ready(detail: impl Into<String>) -> Self {
        Self {
            installed: true,
            ready: true,
            detail: detail.into(),
        }
    }

    pub fn blocked(detail: impl Into<String>) -> Self {
        Self {
            installed: true,
            ready: false,
            detail: detail.into(),
        }
    }
}

impl DoctorReport {
    pub fn missing_required(&self) -> Vec<&'static str> {
        self.dependencies
            .iter()
            .filter(|dep| dep.required && !dep.installed)
            .map(|dep| dep.name)
            .collect()
    }
}

impl SetupReadiness {
    pub fn from_host() -> Self {
        let gh = thread::spawn(gh_readiness);
        // Probe every agent concurrently. Each probe shells out with a 2s
        // timeout, so serially this would scale badly as the registry grows.
        let probes = agent_tools()
            .map(|tool| {
                (
                    tool,
                    thread::spawn(|| provider_readiness(tool.provider_key)),
                )
            })
            .collect::<Vec<_>>();

        Self {
            gh: gh
                .join()
                .unwrap_or_else(|_| SetupCheck::blocked("GitHub CLI check failed.")),
            providers: probes
                .into_iter()
                .map(|(tool, probe)| ProviderReadiness {
                    provider_key: tool.provider_key,
                    display_name: tool.display_name,
                    launchable: tool.chat_launchable
                        && tool.launch_owner != LaunchOwner::NotSupported,
                    check: probe.join().unwrap_or_else(|_| {
                        SetupCheck::blocked(format!("{} check failed.", tool.display_name))
                    }),
                })
                .collect(),
        }
    }

    pub fn any_agent_ready(&self) -> bool {
        self.first_ready_launchable_provider().is_some()
    }

    pub fn first_ready_launchable_provider(&self) -> Option<&'static str> {
        self.providers
            .iter()
            .find(|provider| provider.launchable && provider.check.ready)
            .map(|provider| provider.provider_key)
    }

    pub fn provider_ready(&self, provider: &str) -> bool {
        self.provider(provider)
            .is_some_and(|provider| provider.check.ready)
    }

    pub fn launchable_provider_ready(&self, provider: &str) -> bool {
        launchable_provider_key(provider)
            .and_then(|provider| self.provider(provider))
            .is_some_and(|provider| provider.check.ready)
    }

    /// Resolves through the registry so aliases (`claude-code`, `open-code`)
    /// find the same entry the canonical key would.
    pub fn provider(&self, provider: &str) -> Option<&ProviderReadiness> {
        let canonical = canonical_provider_key(provider)?;
        self.providers
            .iter()
            .find(|candidate| candidate.provider_key == canonical)
    }

    /// Agents that are installed but not usable yet — the ones worth naming in
    /// a "sign in to X" prompt.
    fn installed_but_not_ready(&self) -> Vec<&'static str> {
        self.providers
            .iter()
            .filter(|provider| {
                provider.launchable && provider.check.installed && !provider.check.ready
            })
            .map(|provider| provider.display_name)
            .collect()
    }

    fn launchable_names(&self) -> Vec<&'static str> {
        self.providers
            .iter()
            .filter(|provider| provider.launchable)
            .map(|provider| provider.display_name)
            .collect()
    }
}

pub fn refresh_process_environment() -> Result<bool, String> {
    #[cfg(windows)]
    {
        refresh_windows_process_environment()
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[cfg(windows)]
fn refresh_windows_process_environment() -> Result<bool, String> {
    use std::ffi::{OsStr, OsString};

    let system_root =
        std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
    let powershell = Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let output = Command::new(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); @([Environment]::GetEnvironmentVariable('Path','Machine'), [Environment]::GetEnvironmentVariable('Path','User')) | ConvertTo-Json -Compress",
        ])
        .output()
        .map_err(|error| format!("could not read the current Windows environment: {error}"))?;
    if !output.status.success() {
        return Err(
            "Windows environment query failed; restart Archductor to reload PATH.".to_owned(),
        );
    }

    let encoded = String::from_utf8(output.stdout)
        .map_err(|_| "Windows environment query returned invalid UTF-8.".to_owned())?;
    let paths: Vec<Option<String>> = serde_json::from_str(encoded.trim())
        .map_err(|error| format!("could not parse the current Windows PATH: {error}"))?;
    let current = std::env::var_os("PATH").unwrap_or_default();
    let machine = paths
        .first()
        .and_then(|value| value.as_deref())
        .unwrap_or("");
    let user = paths
        .get(1)
        .and_then(|value| value.as_deref())
        .unwrap_or("");
    let refreshed =
        merge_search_path_sources([current.as_os_str(), OsStr::new(machine), OsStr::new(user)])?;
    let changed = refreshed != current;
    std::env::set_var("PATH", refreshed);
    Ok(changed)
}

#[cfg(windows)]
fn merge_search_path_sources<'a>(
    sources: impl IntoIterator<Item = &'a std::ffi::OsStr>,
) -> Result<std::ffi::OsString, String> {
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    for source in sources {
        for path in std::env::split_paths(source) {
            if path.as_os_str().is_empty() {
                continue;
            }
            let key = path.to_string_lossy().to_ascii_lowercase();
            if seen.insert(key) {
                entries.push(path);
            }
        }
    }
    std::env::join_paths(entries)
        .map_err(|error| format!("could not rebuild the current Windows PATH: {error}"))
}

pub fn setup_blockers(readiness: &SetupReadiness) -> Vec<SetupBlocker> {
    let mut blockers = Vec::new();
    if !readiness.gh.ready {
        blockers.push(SetupBlocker::GithubUnavailable);
    }
    if readiness.first_ready_launchable_provider().is_none() {
        blockers.push(SetupBlocker::MissingAgent);
    }
    blockers
}

pub fn setup_blockers_for_provider(
    readiness: &SetupReadiness,
    provider: Option<&str>,
) -> Vec<SetupBlocker> {
    let mut blockers = setup_blockers(readiness);
    if let Some(provider) = provider {
        if !provider.trim().is_empty() && !readiness.launchable_provider_ready(provider) {
            blockers.push(SetupBlocker::SelectedProviderUnavailable);
        }
    }
    blockers
}

/// Ready = tool works; Action = installed but needs sign-in/auth; Missing =
/// not installed. Mirrors the pill states the setup modal renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupRowState {
    Ready,
    Action,
    Missing,
}

/// One dependency row in the setup report (GitHub CLI, an agent, or the
/// selected provider).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupRow {
    pub name: String,
    pub detail: String,
    pub state: SetupRowState,
    pub required: bool,
    /// Set for agent rows, absent for GitHub CLI and the summary row. Lets a
    /// client act on the row (install, sign in, select) without matching on
    /// the display name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_key: Option<String>,
    /// False for agents the registry knows about but this build cannot drive
    /// as a chat session. They are shown because "detected but not usable" is
    /// more useful than silence.
    #[serde(default = "default_true")]
    pub launchable: bool,
}

fn default_true() -> bool {
    true
}

/// UI-ready setup readiness snapshot. Built server-side so the feedback and
/// provider-selection logic stays tested in one place (ported from the GTK
/// setup flow).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupReport {
    pub rows: Vec<SetupRow>,
    pub feedback: String,
    pub complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_error: Option<String>,
}

impl SetupReport {
    pub fn from_readiness(readiness: &SetupReadiness, refresh_error: Option<String>) -> Self {
        // One row for every agent rather than one row per agent. The registry
        // keeps growing, and a gate that lists a dozen "Missing" providers
        // reads as a dozen chores when the requirement is simply "have one".
        let ready_provider = readiness
            .providers
            .iter()
            .find(|provider| provider.launchable && provider.check.ready);
        let rows = vec![
            setup_row("GitHub CLI", &readiness.gh, true),
            SetupRow {
                provider_key: ready_provider.map(|p| p.provider_key.to_owned()),
                launchable: ready_provider.is_some(),
                ..setup_row("Coding agent", &agent_check(readiness), true)
            },
        ];
        Self {
            complete: setup_blockers(readiness).is_empty(),
            feedback: setup_feedback(readiness),
            rows,
            refresh_error,
        }
    }
}

/// Probe host setup readiness and build a UI-ready report. When `recheck` is
/// true, refresh the process environment first so a just-installed tool is
/// picked up (mirrors the GTK "Recheck" button).
pub fn setup_report(recheck: bool) -> SetupReport {
    let refresh_error = if recheck {
        refresh_process_environment().err()
    } else {
        None
    };
    SetupReport::from_readiness(&SetupReadiness::from_host(), refresh_error)
}

fn setup_row(name: &str, check: &SetupCheck, required: bool) -> SetupRow {
    let state = if check.ready {
        SetupRowState::Ready
    } else if check.installed {
        SetupRowState::Action
    } else {
        SetupRowState::Missing
    };
    SetupRow {
        name: name.to_owned(),
        detail: check.detail.clone(),
        state,
        required,
        provider_key: None,
        launchable: true,
    }
}

/// Joins names the way a sentence needs them: "Codex", "Codex or Claude",
/// "Codex, Claude, or Gemini".
fn or_list(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [only] => (*only).to_owned(),
        [first, second] => format!("{first} or {second}"),
        [rest @ .., last] => format!("{}, or {last}", rest.join(", ")),
    }
}

fn setup_feedback(readiness: &SetupReadiness) -> String {
    let installed = readiness.installed_but_not_ready();
    match setup_blockers(readiness).as_slice() {
        [] => "Setup is complete.".to_owned(),
        [SetupBlocker::GithubUnavailable] if readiness.gh.installed => {
            "Authenticate GitHub CLI, then press Recheck.".to_owned()
        }
        [SetupBlocker::GithubUnavailable] => {
            "Install and authenticate GitHub CLI, then press Recheck.".to_owned()
        }
        // Naming the agents that are already installed is more actionable than
        // listing everything the registry knows about.
        [SetupBlocker::MissingAgent] if !installed.is_empty() => {
            format!("Sign in to {}, then press Recheck.", or_list(&installed))
        }
        [SetupBlocker::MissingAgent] => format!(
            "Install and sign in to {}, then press Recheck.",
            or_list(&readiness.launchable_names()),
        ),
        [SetupBlocker::SelectedProviderUnavailable] => {
            "Choose a ready provider or sign in to the selected provider, then press Recheck."
                .to_owned()
        }
        _ => format!(
            "Install or authenticate GitHub CLI and {}, then press Recheck.",
            or_list(&readiness.launchable_names()),
        ),
    }
}

/// Whether *any* supported agent is usable, plus the most useful thing to say
/// when none is.
fn agent_check(readiness: &SetupReadiness) -> SetupCheck {
    if let Some(provider) = readiness.first_ready_launchable_provider() {
        return SetupCheck::ready(format!("{provider} will be selected for new chats."));
    }
    // An agent that is installed and authenticated but that this build cannot
    // drive is the most confusing possible state, so say so by name rather
    // than reporting a flat "nothing is ready".
    let detected = readiness
        .providers
        .iter()
        .filter(|provider| !provider.launchable && provider.check.ready)
        .map(|provider| provider.display_name)
        .collect::<Vec<_>>();
    if !detected.is_empty() {
        return SetupCheck::blocked(format!(
            "{} ready, but this build cannot launch {} chat sessions yet.",
            or_list(&detected),
            if detected.len() == 1 { "its" } else { "their" },
        ));
    }
    // Naming the candidates is the difference between "something is missing"
    // and "here is what to install".
    let candidates = readiness
        .providers
        .iter()
        .filter(|provider| provider.launchable)
        .map(|provider| provider.display_name)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return SetupCheck::missing("Install and sign in to a supported coding agent.");
    }
    SetupCheck::missing(format!(
        "Set up at least one supported agent: {}.",
        or_list(&candidates)
    ))
}

pub fn report_from_os_release(os_release: &str) -> DoctorReport {
    let parsed = parse_os_release(os_release);
    let distro_id = parsed.get("ID").cloned();
    let distro_like: Vec<String> = parsed
        .get("ID_LIKE")
        .map(|value| value.split_whitespace().map(str::to_owned).collect())
        .unwrap_or_default();

    DoctorReport {
        install_command: install_command(distro_id.as_deref(), &distro_like),
        distro_id,
        distro_like,
        dependencies: dependency_checks(),
    }
}

pub fn report_from_host() -> DoctorReport {
    #[cfg(windows)]
    {
        report_from_os_release("ID=windows")
    }
    #[cfg(not(windows))]
    let os_release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    #[cfg(not(windows))]
    report_from_os_release(&os_release)
}

fn parse_os_release(input: &str) -> HashMap<String, String> {
    input
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_owned(), value.trim_matches('"').to_owned()))
        .collect()
}

fn install_command(id: Option<&str>, like: &[String]) -> Option<&'static str> {
    let matches = |needle: &str| id == Some(needle) || like.iter().any(|item| item == needle);

    if matches("windows") {
        Some("winget install Git.Git GitHub.cli")
    } else if matches("ubuntu") || matches("debian") {
        Some("sudo apt update && sudo apt install git gh sqlite3 openssh-client")
    } else if matches("fedora") {
        Some("sudo dnf install git gh sqlite openssh-clients")
    } else if matches("arch") {
        Some("sudo pacman -S git github-cli sqlite openssh")
    } else if matches("opensuse") || matches("suse") {
        Some("sudo zypper install git gh sqlite3 openssh")
    } else if matches("alpine") {
        Some("sudo apk add git github-cli sqlite openssh-client")
    } else if matches("gentoo") {
        Some("sudo emerge --ask dev-vcs/git dev-util/github-cli dev-db/sqlite net-misc/openssh")
    } else if matches("void") {
        Some("sudo xbps-install -S git github-cli sqlite openssh")
    } else if matches("nixos") {
        Some("nix-shell -p git gh sqlite openssh")
    } else {
        None
    }
}

fn dependency_checks() -> Vec<DependencyCheck> {
    let mut checks = [
        ("git", true),
        ("gh", true),
        ("sqlite3", true),
        ("ssh", true),
    ]
    .into_iter()
    .map(|(name, required)| DependencyCheck {
        name,
        required,
        installed: command_exists(name),
    })
    .collect::<Vec<_>>();
    checks.extend(all_tools().iter().map(|tool| DependencyCheck {
        name: tool.default_command,
        required: false,
        installed: command_exists(tool.default_command),
    }));
    checks
}

fn gh_readiness() -> SetupCheck {
    if !command_exists("gh") {
        return SetupCheck::missing("Install GitHub CLI.");
    }
    if gh_active_account_ready() {
        SetupCheck::ready("Authenticated with GitHub.")
    } else {
        SetupCheck::blocked(
            "Run `gh auth login --hostname github.com` or `gh auth switch --hostname github.com`.",
        )
    }
}

fn gh_active_account_ready() -> bool {
    let Some(output) = command_output("gh", &["auth", "status", "--json", "hosts"]) else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    gh_status_has_active_github_account(&output.stdout)
}

fn gh_status_has_active_github_account(stdout: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(stdout) else {
        return false;
    };
    value
        .get("hosts")
        .and_then(|hosts| hosts.get("github.com"))
        .and_then(serde_json::Value::as_array)
        .map(|accounts| {
            accounts.iter().any(|account| {
                account.get("active").and_then(serde_json::Value::as_bool) == Some(true)
                    && account.get("state").and_then(serde_json::Value::as_str) == Some("success")
            })
        })
        .unwrap_or(false)
}

fn provider_readiness(provider: &str) -> SetupCheck {
    if provider == "claude" {
        return setup_check_from_claude_status(claude_cli_status_from_host());
    }
    let Some(tool) = tool_by_provider(provider) else {
        return SetupCheck::missing(format!("Install {provider}."));
    };
    readiness_for_tool(tool)
}

fn setup_check_from_claude_status(status: ClaudeCliStatus) -> SetupCheck {
    if !status.installed {
        SetupCheck::missing(status.detail)
    } else if status.authenticated && status.supported {
        SetupCheck::ready(status.detail)
    } else {
        SetupCheck::blocked(status.detail)
    }
}

pub fn claude_cli_status_from_host() -> ClaudeCliStatus {
    claude_cli_status_for_command("claude")
}

pub fn claude_cli_status_for_command(command: &str) -> ClaudeCliStatus {
    if !Path::new(command).exists() && !command_exists(command) {
        return ClaudeCliStatus {
            installed: false,
            authenticated: false,
            version: None,
            supported: false,
            detail: "Install Claude Code.".to_owned(),
        };
    }

    let version = command_output(command, &["--version"])
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|stdout| parse_claude_version(&stdout));
    let supported = version.map(claude_version_supported).unwrap_or(false);

    if !supported {
        return ClaudeCliStatus {
            installed: true,
            authenticated: false,
            version,
            supported: false,
            detail: version
                .map(|version| {
                    format!(
                        "Upgrade Claude Code; found {}.{}.{} and need 2.1.89 or newer.",
                        version.0, version.1, version.2
                    )
                })
                .unwrap_or_else(|| "Upgrade Claude Code to 2.1.89 or newer.".to_owned()),
        };
    }

    let auth_output = command_output(command, &["auth", "status"]);
    let auth_status = auth_output
        .as_ref()
        .map(|output| {
            parse_claude_auth_status(
                &String::from_utf8_lossy(&output.stdout),
                output.status.success(),
            )
        })
        .unwrap_or_else(|| parse_claude_auth_status("", false));

    ClaudeCliStatus {
        installed: true,
        authenticated: auth_status.authenticated,
        version,
        supported,
        detail: if auth_status.authenticated {
            match version {
                Some((major, minor, patch)) => {
                    format!("Claude Code {major}.{minor}.{patch} is authenticated.")
                }
                None => "Claude Code is authenticated.".to_owned(),
            }
        } else {
            "Run `claude auth login`.".to_owned()
        },
    }
}

fn parse_claude_version(input: &str) -> Option<(u16, u16, u16)> {
    input
        .split(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .filter(|candidate| candidate.matches('.').count() >= 2)
        .find_map(|candidate| {
            let parts = candidate
                .split('.')
                .take(3)
                .map(str::parse::<u16>)
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            (parts.len() == 3).then(|| (parts[0], parts[1], parts[2]))
        })
}

fn claude_version_supported(version: (u16, u16, u16)) -> bool {
    version >= (2, 1, 89)
}

fn parse_claude_auth_status(output: &str, command_succeeded: bool) -> ClaudeCliStatus {
    let parsed_authenticated = serde_json::from_str::<serde_json::Value>(output)
        .ok()
        .and_then(|value| {
            value
                .get("authenticated")
                .and_then(serde_json::Value::as_bool)
                .or_else(|| {
                    value
                        .get("status")
                        .and_then(serde_json::Value::as_str)
                        .map(|status| matches!(status, "authenticated" | "logged_in" | "ok"))
                })
        });
    let authenticated = parsed_authenticated.unwrap_or(command_succeeded) && command_succeeded;

    ClaudeCliStatus {
        installed: true,
        authenticated,
        version: None,
        supported: true,
        detail: if authenticated {
            "Claude Code is authenticated.".to_owned()
        } else {
            "Run `claude auth login`.".to_owned()
        },
    }
}

fn readiness_for_tool(tool: &ToolSpec) -> SetupCheck {
    let program = tool
        .readiness_probe
        .first()
        .copied()
        .unwrap_or(tool.default_command);
    if !command_exists(program) {
        return SetupCheck::missing(format!("Install {}.", tool.display_name));
    }
    let readiness_args = tool.readiness_probe.get(1..).unwrap_or_default();
    if command_succeeds(program, readiness_args) {
        SetupCheck::ready(format!("{} is ready.", tool.display_name))
    } else {
        SetupCheck::blocked(tool.auth_guidance)
    }
}

fn command_succeeds(program: &str, args: &[&str]) -> bool {
    command_status(program, args)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn command_output(program: &str, args: &[&str]) -> Option<Output> {
    run_command_with_timeout(program, args, false)
}

fn command_status(program: &str, args: &[&str]) -> Option<Output> {
    run_command_with_timeout(program, args, true)
}

fn run_command_with_timeout(program: &str, args: &[&str], discard_output: bool) -> Option<Output> {
    let mut command = Command::new(program);
    command.args(args);
    if discard_output {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    } else {
        command.stdout(Stdio::piped()).stderr(Stdio::null());
    }
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if started.elapsed() >= PROBE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(not(unix))]
fn path_version_probe_succeeds(path: &Path) -> bool {
    let mut child = match Command::new(path)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() >= PROBE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

pub fn command_exists(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| command_in_path(&paths, name).is_some())
        .unwrap_or(false)
}

/// Resolve a command against an explicit PATH rather than this process's.
///
/// The background service runs with a PATH of its own, so "is `gh` installed?"
/// has a different answer for the daemon than it does for the shell asking the
/// question. `service doctor` needs the daemon's answer.
pub fn command_in_path(search_path: &std::ffi::OsStr, name: &str) -> Option<std::path::PathBuf> {
    std::env::split_paths(search_path).find_map(|dir| {
        command_candidates(&dir, name)
            .into_iter()
            .find(|candidate| is_executable(candidate))
    })
}

fn command_candidates(path: &Path, name: &str) -> Vec<std::path::PathBuf> {
    #[cfg(not(windows))]
    {
        vec![path.join(name)]
    }
    #[cfg(windows)]
    {
        let mut candidates = vec![path.join(name)];
        if Path::new(name).extension().is_none() {
            let extensions = std::env::var_os("PATHEXT")
                .and_then(|value| value.into_string().ok())
                .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_owned());
            candidates.extend(
                extensions
                    .split(';')
                    .filter(|extension| !extension.is_empty())
                    .map(|extension| path.join(format!("{name}{extension}"))),
            );
        }
        candidates
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file() || path_version_probe_succeeds(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds readiness from the live registry so these tests keep covering
    /// every agent as the registry grows. Anything not named is treated as not
    /// installed.
    fn readiness(gh: SetupCheck, checks: &[(&str, SetupCheck)]) -> SetupReadiness {
        SetupReadiness {
            gh,
            providers: agent_tools()
                .map(|tool| ProviderReadiness {
                    provider_key: tool.provider_key,
                    display_name: tool.display_name,
                    launchable: tool.chat_launchable
                        && tool.launch_owner != LaunchOwner::NotSupported,
                    check: checks
                        .iter()
                        .find(|(key, _)| canonical_provider_key(key) == Some(tool.provider_key))
                        .map(|(_, check)| check.clone())
                        .unwrap_or_else(|| SetupCheck::missing("missing")),
                })
                .collect(),
        }
    }

    #[cfg(windows)]
    #[test]
    fn refreshed_search_path_preserves_process_entries_and_adds_installed_tools() {
        let current = std::ffi::OsStr::new(r"C:\msys64\ucrt64\bin;C:\Windows\System32");
        let machine = std::ffi::OsStr::new(r"C:\Windows\System32;C:\Program Files\GitHub CLI");
        let user = std::ffi::OsStr::new(r"C:\Users\dev\bin");

        let refreshed = merge_search_path_sources([current, machine, user]).unwrap();
        let entries = std::env::split_paths(&refreshed).collect::<Vec<_>>();

        assert_eq!(entries[0], Path::new(r"C:\msys64\ucrt64\bin"));
        assert!(entries.contains(&Path::new(r"C:\Program Files\GitHub CLI").to_path_buf()));
        assert!(entries.contains(&Path::new(r"C:\Users\dev\bin").to_path_buf()));
        assert_eq!(
            entries
                .iter()
                .filter(|path| path
                    .as_os_str()
                    .eq_ignore_ascii_case(r"C:\Windows\System32"))
                .count(),
            1
        );
    }

    #[test]
    fn selects_apt_guidance_for_ubuntu() {
        let report = report_from_os_release(
            r#"
ID=ubuntu
ID_LIKE=debian
"#,
        );

        assert_eq!(
            report.install_command,
            Some("sudo apt update && sudo apt install git gh sqlite3 openssh-client")
        );
    }

    #[test]
    fn selects_pacman_guidance_for_arch_derivatives() {
        let report = report_from_os_release(
            r#"
ID=endeavouros
ID_LIKE=arch
"#,
        );

        assert_eq!(
            report.install_command,
            Some("sudo pacman -S git github-cli sqlite openssh")
        );
    }

    #[test]
    fn selects_apk_guidance_for_alpine() {
        let report = report_from_os_release("ID=alpine");
        assert_eq!(
            report.install_command,
            Some("sudo apk add git github-cli sqlite openssh-client")
        );
    }

    #[test]
    fn selects_winget_guidance_for_windows() {
        let report = report_from_os_release("ID=windows");
        assert_eq!(
            report.install_command,
            Some("winget install Git.Git GitHub.cli")
        );
    }

    #[test]
    fn setup_blockers_require_github_cli() {
        let readiness = readiness(
            SetupCheck::missing("missing"),
            &[("codex", SetupCheck::ready("ready"))],
        );

        assert_eq!(
            setup_blockers(&readiness),
            vec![SetupBlocker::GithubUnavailable]
        );
    }

    #[test]
    fn setup_blockers_require_at_least_one_agent() {
        let readiness = readiness(SetupCheck::ready("ready"), &[]);

        assert_eq!(setup_blockers(&readiness), vec![SetupBlocker::MissingAgent]);
    }

    #[test]
    fn setup_blockers_require_launchable_agent_even_when_opencode_ready() {
        let readiness = readiness(
            SetupCheck::ready("ready"),
            &[("opencode", SetupCheck::ready("ready"))],
        );

        assert_eq!(setup_blockers(&readiness), vec![SetupBlocker::MissingAgent]);
    }

    #[test]
    fn setup_blockers_include_selected_provider_readiness() {
        let readiness = readiness(
            SetupCheck::ready("ready"),
            &[("claude", SetupCheck::ready("ready"))],
        );

        assert_eq!(
            setup_blockers_for_provider(&readiness, Some("codex")),
            vec![SetupBlocker::SelectedProviderUnavailable]
        );
        assert!(setup_blockers_for_provider(&readiness, Some("claude")).is_empty());
        assert_eq!(
            setup_blockers_for_provider(&readiness, Some("opencode")),
            vec![SetupBlocker::SelectedProviderUnavailable]
        );
    }

    #[test]
    fn first_ready_launchable_provider_prefers_codex_then_claude() {
        let readiness = readiness(
            SetupCheck::ready("ready"),
            &[
                ("claude", SetupCheck::ready("ready")),
                ("opencode", SetupCheck::ready("ready")),
            ],
        );

        assert_eq!(readiness.first_ready_launchable_provider(), Some("claude"));
    }

    #[test]
    fn gh_status_requires_active_successful_github_account() {
        let status = br#"
{
  "hosts": {
    "github.com": [
      {"state": "success", "active": false, "host": "github.com", "login": "old"},
      {"state": "success", "active": true, "host": "github.com", "login": "current"}
    ],
    "github.example.com": [
      {"state": "success", "active": true, "host": "github.example.com", "login": "enterprise"}
    ]
  }
}
"#;

        assert!(gh_status_has_active_github_account(status));

        let stale = br#"
{
  "hosts": {
    "github.com": [
      {"state": "failure", "active": true, "host": "github.com", "login": "current"}
    ]
  }
}
"#;

        assert!(!gh_status_has_active_github_account(stale));
    }

    #[test]
    fn claude_cli_status_parses_versions_and_support_floor() {
        assert_eq!(
            parse_claude_version("2.1.177 (Claude Code)"),
            Some((2, 1, 177))
        );
        assert!(claude_version_supported((2, 1, 177)));
        assert!(!claude_version_supported((2, 1, 88)));
    }

    #[test]
    fn claude_cli_status_fails_closed_when_version_probe_cannot_be_parsed() {
        let temp = tempfile::tempdir().unwrap();
        let fake_claude = temp.path().join("claude");
        std::fs::write(
            &fake_claude,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo unknown; exit 0; fi\nexit 0\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake_claude, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let status = claude_cli_status_for_command(fake_claude.to_str().unwrap());

        assert!(status.installed);
        assert!(!status.supported);
        assert!(!status.authenticated);
    }

    #[test]
    fn claude_auth_status_accepts_local_cli_oauth_without_api_key() {
        let success_json = r#"{"authenticated":true,"account":"local-oauth"}"#;
        let status = parse_claude_auth_status(success_json, true);

        assert!(status.installed);
        assert!(status.authenticated);
        assert!(status.supported);

        let failure_json = r#"{"authenticated":false,"error":"login required"}"#;
        let status = parse_claude_auth_status(failure_json, false);

        assert!(status.installed);
        assert!(!status.authenticated);
    }

    #[test]
    fn dependency_checks_include_opencode() {
        let names = dependency_checks()
            .into_iter()
            .map(|dep| dep.name)
            .collect::<Vec<_>>();

        assert!(names.contains(&"opencode"));
    }

    #[test]
    fn setup_feedback_summarizes_missing_github_cli() {
        let readiness = readiness(
            SetupCheck::missing("missing"),
            &[("codex", SetupCheck::ready("ready"))],
        );

        assert_eq!(
            setup_feedback(&readiness),
            "Install and authenticate GitHub CLI, then press Recheck."
        );
    }

    #[test]
    fn setup_feedback_summarizes_missing_agent() {
        let readiness = readiness(SetupCheck::ready("ready"), &[]);

        assert_eq!(
            setup_feedback(&readiness),
            "Install and sign in to Codex, Claude Code, or Gemini CLI, then press Recheck."
        );
    }

    #[test]
    fn setup_feedback_summarizes_installed_but_blocked_agent() {
        let readiness = readiness(
            SetupCheck::ready("ready"),
            &[
                ("codex", SetupCheck::blocked("blocked")),
                ("opencode", SetupCheck::ready("ready")),
            ],
        );

        // Only Codex is installed, so only Codex is worth naming — the old
        // wording listed every launchable agent regardless of what was there.
        assert_eq!(
            setup_feedback(&readiness),
            "Sign in to Codex, then press Recheck."
        );
    }

    #[test]
    fn setup_report_marks_ready_host_complete() {
        let readiness = readiness(
            SetupCheck::ready("Authenticated with GitHub."),
            &[("claude", SetupCheck::ready("ready"))],
        );

        let report = SetupReport::from_readiness(&readiness, None);

        assert!(report.complete);
        assert_eq!(report.feedback, "Setup is complete.");
        // Two rows, whatever the registry grows to: have GitHub, have an agent.
        assert_eq!(report.rows.len(), 2, "{:?}", report.rows);
        assert_eq!(report.rows[0].name, "GitHub CLI");
        assert_eq!(report.rows[0].state, SetupRowState::Ready);
        let agent = &report.rows[1];
        assert_eq!(agent.name, "Coding agent");
        assert_eq!(agent.state, SetupRowState::Ready);
        assert!(agent.detail.contains("claude"));
    }

    /// The gate asks for one agent, not for every agent. A growing registry
    /// must not turn into a growing checklist of chores.
    #[test]
    fn setup_report_stays_two_rows_however_many_agents_exist() {
        let report = SetupReport::from_readiness(&readiness(SetupCheck::ready("ready"), &[]), None);

        assert_eq!(report.rows.len(), 2, "{:?}", report.rows);
        assert_eq!(report.rows[0].name, "GitHub CLI");
        assert_eq!(report.rows[1].name, "Coding agent");
        assert!(
            agent_tools().count() > 2,
            "this test is only meaningful with a registry bigger than the row count"
        );
    }

    /// With nothing installed, the one agent row has to say what would satisfy
    /// it — otherwise it is a blocker with no instruction.
    #[test]
    fn the_agent_row_names_what_would_satisfy_it() {
        let report = SetupReport::from_readiness(&readiness(SetupCheck::ready("ready"), &[]), None);

        let agent = &report.rows[1];
        assert_eq!(agent.state, SetupRowState::Missing);
        assert!(
            agent.detail.contains("at least one"),
            "expected a one-of instruction, got {:?}",
            agent.detail
        );
        assert!(
            agent.detail.contains("Codex") || agent.detail.contains("Claude"),
            "expected named candidates, got {:?}",
            agent.detail
        );
    }

    /// A detected-but-undrivable agent is the most confusing state to land in,
    /// so the summary row names it instead of reporting a flat "nothing ready".
    #[test]
    fn the_agent_row_names_a_ready_but_unlaunchable_agent() {
        let readiness = readiness(
            SetupCheck::ready("ready"),
            &[("opencode", SetupCheck::ready("ready"))],
        );

        let check = agent_check(&readiness);

        assert!(!check.ready);
        assert!(check.detail.contains("OpenCode"));
        assert!(check.detail.contains("cannot launch"));
    }

    #[test]
    fn provider_lookup_resolves_registry_aliases() {
        let readiness = readiness(
            SetupCheck::ready("ready"),
            &[("claude", SetupCheck::ready("ready"))],
        );

        assert!(readiness.provider_ready("claude-code"));
        assert!(readiness.provider_ready("Claude Code"));
        assert!(readiness.launchable_provider_ready("claudecode"));
        assert!(readiness.provider("nonexistent-agent").is_none());
    }

    #[test]
    fn or_list_reads_as_a_sentence() {
        assert_eq!(or_list(&[]), "");
        assert_eq!(or_list(&["Codex"]), "Codex");
        assert_eq!(or_list(&["Codex", "Claude Code"]), "Codex or Claude Code");
        assert_eq!(
            or_list(&["Codex", "Claude Code", "Gemini"]),
            "Codex, Claude Code, or Gemini"
        );
    }

    #[test]
    fn setup_report_flags_missing_required_rows() {
        let readiness = readiness(SetupCheck::missing("Install GitHub CLI."), &[]);

        let report = SetupReport::from_readiness(&readiness, Some("refresh failed".to_owned()));

        assert!(!report.complete);
        assert_eq!(report.refresh_error.as_deref(), Some("refresh failed"));
        assert_eq!(report.rows[0].state, SetupRowState::Missing);
        assert!(report.rows[0].required);
    }
}
