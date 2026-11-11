//! "How much usage is left" per agent provider.
//!
//! Every provider CLI we drive knows its own quota, but none of them will print
//! it non-interactively: Claude Code shows it behind `/usage`, Codex behind
//! `/status`, Devin behind `/usage`. So we do what those CLIs do — read the
//! credentials the CLI already stored on this machine and ask the same account
//! endpoint the CLI asks. No extra login, no API key of our own.
//!
//! Adapters are deliberately lenient: a provider that is signed out, signed in
//! a way that has no plan quota (an API key), or that changed its payload shape
//! reports a status and a message rather than failing the whole response.
//!
//! Parsing is pure and tested; the IO around it is a thin `curl` shell-out that
//! keeps tokens out of argv (same pattern as `linear.rs`).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// How long a collected snapshot stays fresh. Quota moves in minutes, not
/// milliseconds, and each refresh is three network calls.
pub const USAGE_CACHE_TTL_SECONDS: i64 = 60;

/// Seconds any one provider probe may take before we report it as unreachable.
const PROBE_TIMEOUT_SECONDS: u32 = 12;

/// How long the macOS Keychain lookup may wait, matching curl's limit.
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(PROBE_TIMEOUT_SECONDS as u64);

/// One bar in the UI: a window ("This week") and how much of it is spent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageMeter {
    /// Window name as the provider words it ("This week", "Fable", "Daily").
    pub label: String,
    /// 0-100, rounded. Percent *used*, so a full bar means no headroom left.
    /// Whole percent keeps the whole response comparable (`Eq`) and is all a
    /// progress bar can show anyway.
    pub percent_used: i64,
    /// Qualifier under the label, when the provider gives one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Epoch seconds when this window resets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
    /// `normal` | `warning` | `critical`.
    pub severity: String,
}

/// One provider's answer. `status` is the thing to branch on:
/// `ok` (meters are real), `unauthenticated` (sign in to that CLI),
/// `unsupported` (this sign-in has no plan quota), `error` (we could not ask).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderUsageReport {
    pub provider_key: String,
    pub display_name: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Why there are no meters, or an extra note when there are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default)]
    pub meters: Vec<UsageMeter>,
    /// Where the user manages this plan, when the provider has such a page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manage_url: Option<String>,
    /// Epoch seconds the snapshot was taken.
    pub checked_at: i64,
}

impl ProviderUsageReport {
    fn new(provider_key: &str, display_name: &str, status: &str, now: i64) -> Self {
        Self {
            provider_key: provider_key.to_owned(),
            display_name: display_name.to_owned(),
            status: status.to_owned(),
            plan: None,
            account: None,
            message: None,
            meters: Vec::new(),
            manage_url: None,
            checked_at: now,
        }
    }

    fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    fn with_manage_url(mut self, url: &str) -> Self {
        self.manage_url = Some(url.to_owned());
        self
    }
}

/// A snapshot and the order its collection started in.
struct CachedUsage {
    generation: u64,
    collected_at: i64,
    reports: Vec<ProviderUsageReport>,
}

struct UsageCacheState {
    snapshot: Option<CachedUsage>,
    /// Collections started so far; the latest one's generation.
    started: u64,
    /// Collections still out asking providers.
    running: usize,
}

/// Provider quota costs three network calls, so one snapshot is shared by every
/// client for a minute. Reads that miss the cache wait for a collection already
/// running rather than starting their own; `refresh` is the user asking again,
/// so it always starts one. Collections can then overlap, and the generation
/// keeps a slow older one from replacing what a newer one already stored.
struct UsageCache {
    state: Mutex<UsageCacheState>,
    settled: Condvar,
}

/// Marks a collection finished even if it panicked, so nobody waits on it forever.
struct RunningCollection<'a>(&'a UsageCache);

impl Drop for RunningCollection<'_> {
    fn drop(&mut self) {
        self.0.lock().running -= 1;
        self.0.settled.notify_all();
    }
}

impl UsageCache {
    const fn new() -> Self {
        Self {
            state: Mutex::new(UsageCacheState {
                snapshot: None,
                started: 0,
                running: 0,
            }),
            settled: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, UsageCacheState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `clock` runs with the cache locked.
    fn snapshot(
        &self,
        refresh: bool,
        clock: impl Fn() -> i64,
        collect: impl FnOnce() -> Vec<ProviderUsageReport>,
    ) -> (Vec<ProviderUsageReport>, i64) {
        let mut state = self.lock();
        let (generation, collected_at) = loop {
            let now = clock();
            if !refresh {
                if let Some(cached) = &state.snapshot {
                    if now - cached.collected_at < USAGE_CACHE_TTL_SECONDS {
                        return (cached.reports.clone(), cached.collected_at);
                    }
                }
                if state.running > 0 {
                    state = self
                        .settled
                        .wait(state)
                        .unwrap_or_else(PoisonError::into_inner);
                    continue;
                }
            }
            state.started += 1;
            state.running += 1;
            break (state.started, now);
        };
        drop(state);

        let _running = RunningCollection(self);
        let reports = collect();
        let mut state = self.lock();
        match &state.snapshot {
            Some(newer) if newer.generation > generation => {
                (newer.reports.clone(), newer.collected_at)
            }
            _ => {
                state.snapshot = Some(CachedUsage {
                    generation,
                    collected_at,
                    reports: reports.clone(),
                });
                (reports, collected_at)
            }
        }
    }
}

/// The snapshot every client shares; see [`UsageCache`].
pub fn provider_usage_snapshot(refresh: bool) -> (Vec<ProviderUsageReport>, i64) {
    static CACHE: UsageCache = UsageCache::new();
    CACHE.snapshot(refresh, now_epoch, collect_provider_usage)
}

/// A provider key and the probe that answers for it.
type Probe = (&'static str, fn() -> ProviderUsageReport);

/// Ask every provider we can, in parallel. Never fails as a whole: a provider
/// that cannot answer contributes a report explaining why.
pub fn collect_provider_usage() -> Vec<ProviderUsageReport> {
    collect_from(vec![
        ("claude", claude_usage),
        ("codex", codex_usage),
        ("devin", devin_usage),
    ])
}

fn collect_from(probes: Vec<Probe>) -> Vec<ProviderUsageReport> {
    let handles: Vec<_> = probes
        .into_iter()
        .map(|(key, probe)| {
            std::thread::Builder::new()
                .name(format!("usage-{key}"))
                .spawn(probe)
                .map(|handle| (key, handle))
        })
        .collect();
    let now = now_epoch();
    handles
        .into_iter()
        .filter_map(|spawned| match spawned {
            Ok((key, handle)) => Some(handle.join().unwrap_or_else(|_| {
                ProviderUsageReport::new(key, display_name_for(key), "error", now)
                    .with_message("usage probe panicked")
            })),
            Err(_) => None,
        })
        .collect()
}

fn display_name_for(provider_key: &str) -> &'static str {
    match provider_key {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "devin" => "Devin",
        _ => "Agent",
    }
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/// Claude Code stores an OAuth token (macOS keychain, or `~/.claude/.credentials.json`
/// elsewhere) and `/usage` reads `api.anthropic.com/api/oauth/usage` with it.
fn claude_usage() -> ProviderUsageReport {
    claude_usage_with(claude_credentials(), now_epoch())
}

fn claude_usage_with(
    credentials: Result<Option<ClaudeCredentials>>,
    now: i64,
) -> ProviderUsageReport {
    let credentials = match credentials {
        Ok(Some(credentials)) => credentials,
        Ok(None) => return claude_signed_out_report(now),
        Err(err) => {
            return ProviderUsageReport::new("claude", "Claude Code", "error", now)
                .with_message(format!("could not read Claude credentials: {err}"))
                .with_manage_url("https://claude.ai/settings/usage")
        }
    };
    let body = match run_curl(&claude_usage_request(&credentials.access_token)) {
        Ok(body) => body,
        Err(err) => {
            return ProviderUsageReport::new("claude", "Claude Code", "error", now)
                .with_message(format!("could not read Claude usage: {err}"))
        }
    };
    let mut report = match parse_claude_usage(&body, now) {
        Ok(meters) => {
            let mut report = ProviderUsageReport::new("claude", "Claude Code", "ok", now);
            report.meters = meters;
            report
        }
        Err(err) => ProviderUsageReport::new("claude", "Claude Code", "error", now)
            .with_message(format!("could not read Claude usage: {err}")),
    };
    report.plan = credentials.plan;
    report.manage_url = Some("https://claude.ai/settings/usage".to_owned());
    report
}

/// No stored sign-in. An API key still runs agents (see `crate::mcp`), it just
/// has no plan quota to show.
fn claude_signed_out_report(now: i64) -> ProviderUsageReport {
    if env_key_present(&["ANTHROPIC_API_KEY"]) {
        return ProviderUsageReport::new("claude", "Claude Code", "unsupported", now)
            .with_message(
                "Claude Code is using an API key, which bills per token and has no plan quota.",
            )
            .with_manage_url("https://console.anthropic.com/settings/usage");
    }
    ProviderUsageReport::new("claude", "Claude Code", "unauthenticated", now)
        .with_message("Claude Code is not signed in on this machine. Run `claude` and sign in.")
}

struct ClaudeCredentials {
    access_token: String,
    plan: Option<String>,
}

fn claude_credentials() -> Result<Option<ClaudeCredentials>> {
    Ok(claude_credentials_json()?
        .as_deref()
        .and_then(parse_claude_credentials))
}

fn claude_credentials_json() -> Result<Option<String>> {
    let Some(home) = crate::platform::home_dir() else {
        return Ok(None);
    };
    if let Ok(text) = std::fs::read_to_string(home.join(".claude/.credentials.json")) {
        return Ok(Some(text));
    }
    if cfg!(target_os = "macos") {
        let mut lookup = Command::new("security");
        lookup.args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ]);
        return keychain_output(&mut lookup, KEYCHAIN_TIMEOUT);
    }
    Ok(None)
}

/// Keychain can sit waiting for an unlock or an approval for as long as nobody
/// answers, so the lookup gets a deadline. Passing it is an error, not "signed
/// out": the credentials may well be there. A lookup that ends on its own and
/// finds nothing is the signed-out case.
fn keychain_output(lookup: &mut Command, timeout: Duration) -> Result<Option<String>> {
    let Ok(mut child) = lookup
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Ok(None);
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().context("read Keychain lookup")?;
                return Ok(status
                    .success()
                    .then(|| String::from_utf8_lossy(&output.stdout).into_owned()));
            }
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!(
                    "Keychain did not answer within {} seconds; it may be locked",
                    timeout.as_secs()
                );
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err).context("wait on Keychain lookup");
            }
        }
    }
}

fn parse_claude_credentials(raw: &str) -> Option<ClaudeCredentials> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let oauth = value.get("claudeAiOauth")?;
    let access_token = oauth.get("accessToken").and_then(Value::as_str)?.to_owned();
    if access_token.is_empty() {
        return None;
    }
    let plan = oauth
        .get("subscriptionType")
        .and_then(Value::as_str)
        .map(|plan| {
            let mut chars = plan.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => plan.to_owned(),
            }
        });
    Some(ClaudeCredentials { access_token, plan })
}

fn claude_usage_request(access_token: &str) -> CurlRequest {
    CurlRequest::get(
        "https://api.anthropic.com/api/oauth/usage",
        &[
            format!("Authorization: Bearer {access_token}"),
            "anthropic-beta: oauth-2025-04-20".to_owned(),
        ],
    )
}

/// `limits[]` is the same list `/usage` renders: one entry per active window,
/// plus pay-as-you-go credits in `extra_usage` when the user turned those on.
pub fn parse_claude_usage(body: &str, now: i64) -> Result<Vec<UsageMeter>> {
    let value: Value = serde_json::from_str(body).context("parse Claude usage response")?;
    let mut meters = Vec::new();
    for limit in value
        .get("limits")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let kind = limit.get("kind").and_then(Value::as_str).unwrap_or("limit");
        let percent = limit.get("percent").and_then(Value::as_f64).unwrap_or(0.0);
        meters.push(UsageMeter {
            label: claude_limit_label(kind, limit.get("scope")),
            percent_used: round_percent(percent),
            detail: None,
            resets_at: limit
                .get("resets_at")
                .and_then(Value::as_str)
                .and_then(epoch_seconds_from_rfc3339),
            severity: normalize_severity(limit.get("severity").and_then(Value::as_str), percent),
        });
    }
    if let Some(extra) = value.get("extra_usage") {
        if extra.get("is_enabled").and_then(Value::as_bool) == Some(true) {
            let percent = extra
                .get("utilization")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let detail = match (
                extra.get("used_credits").and_then(Value::as_f64),
                extra.get("monthly_limit").and_then(Value::as_f64),
            ) {
                (Some(used), Some(limit)) if limit > 0.0 => {
                    Some(format!("${used:.2} of ${:.2} this month", limit / 100.0))
                }
                _ => None,
            };
            meters.push(UsageMeter {
                label: "Extra usage".to_owned(),
                percent_used: round_percent(percent),
                detail,
                resets_at: None,
                severity: normalize_severity(None, percent),
            });
        }
    }
    let _ = now;
    Ok(meters)
}

fn claude_limit_label(kind: &str, scope: Option<&Value>) -> String {
    if let Some(model) = scope
        .and_then(|scope| scope.get("model"))
        .and_then(|model| model.get("display_name"))
        .and_then(Value::as_str)
    {
        return model.to_owned();
    }
    match kind {
        "weekly_all" => "This week".to_owned(),
        "weekly_scoped" => "This week (scoped)".to_owned(),
        "five_hour" => "Current session".to_owned(),
        other => title_case_words(other),
    }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/// Codex only has a plan quota when it is signed in with ChatGPT; API-key
/// sign-ins bill per token and have nothing to show. With ChatGPT auth,
/// `~/.codex/auth.json` holds the access token `/status` uses.
fn codex_usage() -> ProviderUsageReport {
    let now = now_epoch();
    let Some(path) = crate::platform::home_dir().map(|home| home.join(".codex/auth.json")) else {
        return codex_signed_out_report(now);
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return codex_signed_out_report(now);
    };
    match parse_codex_auth(&raw) {
        CodexAuth::ChatGpt {
            access_token,
            account_id,
        } => {
            let body = match run_curl(&codex_usage_request(&access_token, account_id.as_deref())) {
                Ok(body) => body,
                Err(err) => {
                    return ProviderUsageReport::new("codex", "Codex", "error", now)
                        .with_message(format!("could not read Codex usage: {err}"))
                        .with_manage_url("https://chatgpt.com/admin/billing")
                }
            };
            match parse_codex_usage(&body, now) {
                Ok(meters) if meters.is_empty() => {
                    ProviderUsageReport::new("codex", "Codex", "ok", now)
                        .with_message("ChatGPT plan reported no active limit window.")
                        .with_manage_url("https://chatgpt.com/admin/billing")
                }
                Ok(meters) => {
                    let mut report = ProviderUsageReport::new("codex", "Codex", "ok", now);
                    report.meters = meters;
                    report.plan = parse_codex_plan(&body);
                    report.manage_url = Some("https://chatgpt.com/admin/billing".to_owned());
                    report
                }
                Err(err) => ProviderUsageReport::new("codex", "Codex", "error", now)
                    .with_message(format!("could not read Codex usage: {err}")),
            }
        }
        CodexAuth::ApiKey => codex_api_key_report(now),
        CodexAuth::None => codex_signed_out_report(now),
    }
}

fn codex_api_key_report(now: i64) -> ProviderUsageReport {
    ProviderUsageReport::new("codex", "Codex", "unsupported", now)
        .with_message(
            "Codex is signed in with an API key, which bills per token and has no plan quota.",
        )
        .with_manage_url("https://platform.openai.com/usage")
}

/// No stored sign-in. As with Claude, an API key in the environment still runs
/// agents (see `crate::mcp`).
fn codex_signed_out_report(now: i64) -> ProviderUsageReport {
    if env_key_present(&["OPENAI_API_KEY", "OPENAI_API_TOKEN"]) {
        return codex_api_key_report(now);
    }
    ProviderUsageReport::new("codex", "Codex", "unauthenticated", now)
        .with_message("Codex is not signed in on this machine. Run `codex login`.")
}

#[derive(Debug, PartialEq)]
pub enum CodexAuth {
    ChatGpt {
        access_token: String,
        account_id: Option<String>,
    },
    ApiKey,
    None,
}

pub fn parse_codex_auth(raw: &str) -> CodexAuth {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return CodexAuth::None;
    };
    let tokens = value.get("tokens");
    let access_token = tokens
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty());
    if let Some(access_token) = access_token {
        return CodexAuth::ChatGpt {
            access_token: access_token.to_owned(),
            account_id: tokens
                .and_then(|tokens| tokens.get("account_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
    }
    if value
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.is_empty())
    {
        return CodexAuth::ApiKey;
    }
    CodexAuth::None
}

fn codex_usage_request(access_token: &str, account_id: Option<&str>) -> CurlRequest {
    let mut headers = vec![format!("Authorization: Bearer {access_token}")];
    if let Some(account_id) = account_id {
        headers.push(format!("chatgpt-account-id: {account_id}"));
    }
    CurlRequest::get("https://chatgpt.com/backend-api/codex/usage", &headers)
}

/// Codex reports a primary and a secondary rolling window, each as a percent
/// used plus the seconds until it resets. The window length names the bar.
pub fn parse_codex_usage(body: &str, now: i64) -> Result<Vec<UsageMeter>> {
    let value: Value = serde_json::from_str(body).context("parse Codex usage response")?;
    let limits = value
        .get("rate_limits")
        .or_else(|| {
            value
                .get("usage")
                .and_then(|usage| usage.get("rate_limits"))
        })
        .cloned()
        .unwrap_or(Value::Null);
    let mut meters = Vec::new();
    for (key, fallback) in [("primary", "Current window"), ("secondary", "This week")] {
        let Some(window) = limits.get(key) else {
            continue;
        };
        let percent = window
            .get("used_percent")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let minutes = window.get("window_minutes").and_then(Value::as_i64);
        meters.push(UsageMeter {
            label: codex_window_label(minutes).unwrap_or_else(|| fallback.to_owned()),
            percent_used: round_percent(percent),
            detail: None,
            resets_at: window
                .get("resets_in_seconds")
                .and_then(Value::as_i64)
                .map(|seconds| now + seconds),
            severity: normalize_severity(None, percent),
        });
    }
    Ok(meters)
}

fn parse_codex_plan(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    value
        .get("plan_type")
        .and_then(Value::as_str)
        .map(title_case_words)
}

fn codex_window_label(window_minutes: Option<i64>) -> Option<String> {
    match window_minutes? {
        minutes if minutes <= 60 => Some("This hour".to_owned()),
        minutes if minutes <= 60 * 8 => Some(format!("Current {}h window", minutes / 60)),
        minutes if minutes <= 60 * 24 => Some("Today".to_owned()),
        minutes if minutes <= 60 * 24 * 8 => Some("This week".to_owned()),
        _ => Some("This month".to_owned()),
    }
}

// ---------------------------------------------------------------------------
// Devin
// ---------------------------------------------------------------------------

/// The Devin CLI keeps its API key in `credentials.toml` and reads quota from
/// the same Connect RPC its `/usage` command uses.
fn devin_usage() -> ProviderUsageReport {
    let now = now_epoch();
    let Some(credentials) = devin_credentials() else {
        return ProviderUsageReport::new("devin", "Devin", "unauthenticated", now)
            .with_message("Devin is not signed in on this machine. Run `devin auth login`.")
            .with_manage_url("https://app.devin.ai/settings/usage");
    };
    let body = match run_curl(&devin_usage_request(
        &credentials.api_key,
        &credentials.api_server_url,
    )) {
        Ok(body) => body,
        Err(err) => {
            return ProviderUsageReport::new("devin", "Devin", "error", now)
                .with_message(format!("could not read Devin usage: {err}"))
                .with_manage_url("https://app.devin.ai/settings/usage")
        }
    };
    match parse_devin_usage(&body) {
        Ok(parsed) => {
            let mut report = ProviderUsageReport::new("devin", "Devin", "ok", now);
            report.meters = parsed.meters;
            report.plan = parsed.plan;
            report.manage_url = Some("https://app.devin.ai/settings/usage".to_owned());
            report
        }
        Err(err) => ProviderUsageReport::new("devin", "Devin", "error", now)
            .with_message(format!("could not read Devin usage: {err}"))
            .with_manage_url("https://app.devin.ai/settings/usage"),
    }
}

struct DevinCredentials {
    api_key: String,
    api_server_url: String,
}

fn devin_credentials() -> Option<DevinCredentials> {
    let raw = std::fs::read_to_string(devin_credentials_path()?).ok()?;
    parse_devin_credentials(&raw)
}

fn devin_credentials_path() -> Option<PathBuf> {
    let home = crate::platform::home_dir()?;
    let data_dir = match std::env::var("XDG_DATA_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home.join(".local/share"),
    };
    Some(data_dir.join("devin/credentials.toml"))
}

fn parse_devin_credentials(raw: &str) -> Option<DevinCredentials> {
    let parsed = toml::from_str::<toml::Value>(raw).ok()?;
    let api_key = parsed
        .get("windsurf_api_key")
        .and_then(toml::Value::as_str)
        .filter(|key| !key.is_empty())?
        .to_owned();
    let api_server_url = parsed
        .get("api_server_url")
        .and_then(toml::Value::as_str)
        .filter(|url| !url.is_empty())
        .unwrap_or("https://server.codeium.com")
        .trim_end_matches('/')
        .to_owned();
    Some(DevinCredentials {
        api_key,
        api_server_url,
    })
}

fn devin_usage_request(api_key: &str, api_server_url: &str) -> CurlRequest {
    // The server parses both version fields as semver and answers 500 when they
    // are not, so these carry our crate version rather than a name.
    let payload = serde_json::json!({
        "metadata": {
            "api_key": api_key,
            "ide_name": "chisel",
            "ide_version": env!("CARGO_PKG_VERSION"),
            "extension_name": "chisel",
            "extension_version": env!("CARGO_PKG_VERSION"),
        }
    })
    .to_string();
    CurlRequest::post_json(
        &format!("{api_server_url}/exa.seat_management_pb.SeatManagementService/GetUserStatus"),
        &payload,
    )
}

pub struct DevinUsage {
    pub meters: Vec<UsageMeter>,
    pub plan: Option<String>,
}

/// Devin reports quota as *remaining* percent for a daily and a weekly window,
/// plus ACUs on plans that meter them. We store percent used, so these flip.
pub fn parse_devin_usage(body: &str) -> Result<DevinUsage> {
    let value: Value = serde_json::from_str(body).context("parse Devin usage response")?;
    let status = value
        .get("userStatus")
        .and_then(|status| status.get("planStatus"))
        .context("Devin response did not include plan status")?;
    let mut meters = Vec::new();
    for (remaining_key, reset_key, label) in [
        (
            "dailyQuotaRemainingPercent",
            "dailyQuotaResetAtUnix",
            "Today",
        ),
        (
            "weeklyQuotaRemainingPercent",
            "weeklyQuotaResetAtUnix",
            "This week",
        ),
    ] {
        let Some(remaining) = status.get(remaining_key).and_then(Value::as_f64) else {
            continue;
        };
        let percent = (100.0 - remaining).clamp(0.0, 100.0);
        meters.push(UsageMeter {
            label: label.to_owned(),
            percent_used: round_percent(percent),
            detail: None,
            resets_at: status.get(reset_key).and_then(json_i64),
            severity: normalize_severity(None, percent),
        });
    }
    if let (Some(consumed), Some(limit)) = (
        status.get("acuConsumed").and_then(Value::as_f64),
        status.get("acuLimit").and_then(Value::as_f64),
    ) {
        if limit > 0.0 {
            let percent = (consumed / limit * 100.0).clamp(0.0, 100.0);
            meters.push(UsageMeter {
                label: "ACUs".to_owned(),
                percent_used: round_percent(percent),
                detail: Some(format!("{consumed:.0} of {limit:.0} ACUs")),
                resets_at: None,
                severity: normalize_severity(None, percent),
            });
        }
    }
    let plan = status
        .get("planInfo")
        .and_then(|info| info.get("planName"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(DevinUsage { meters, plan })
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// A curl invocation whose secrets live in the stdin config, never in argv
/// (argv is world-readable in `ps`).
pub struct CurlRequest {
    pub args: Vec<String>,
    pub stdin: String,
}

impl CurlRequest {
    fn get(url: &str, headers: &[String]) -> Self {
        let mut stdin = format!("url = \"{}\"\n", curl_config_escape(url));
        for header in headers {
            stdin.push_str(&format!("header = \"{}\"\n", curl_config_escape(header)));
        }
        Self {
            args: base_curl_args(),
            stdin,
        }
    }

    fn post_json(url: &str, payload: &str) -> Self {
        Self {
            args: base_curl_args(),
            stdin: format!(
                "url = \"{}\"\nheader = \"Content-Type: application/json\"\ndata = \"{}\"\n",
                curl_config_escape(url),
                curl_config_escape(payload)
            ),
        }
    }
}

fn base_curl_args() -> Vec<String> {
    vec![
        "-fsS".to_owned(),
        "--max-time".to_owned(),
        PROBE_TIMEOUT_SECONDS.to_string(),
        "--config".to_owned(),
        "-".to_owned(),
    ]
}

fn run_curl(request: &CurlRequest) -> Result<String> {
    let mut child = Command::new("curl")
        .args(&request.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("run curl")?;
    child
        .stdin
        .as_mut()
        .context("open curl config stdin")?
        .write_all(request.stdin.as_bytes())
        .context("write curl config")?;
    let output = child.wait_with_output().context("wait for curl")?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn env_key_present(keys: &[&str]) -> bool {
    keys.iter()
        .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()))
}

fn curl_config_escape(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| match ch {
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '"' => "\\\"".chars().collect(),
            '\n' => "\\n".chars().collect(),
            '\r' => "\\r".chars().collect(),
            '\t' => "\\t".chars().collect(),
            _ => vec![ch],
        })
        .collect()
}

/// Providers word severity differently (or not at all); the UI only knows
/// these three.
fn normalize_severity(reported: Option<&str>, percent: f64) -> String {
    match reported {
        Some("critical") | Some("exhausted") | Some("blocked") => return "critical".to_owned(),
        Some("warning") | Some("warn") => return "warning".to_owned(),
        _ => {}
    }
    if percent >= 95.0 {
        "critical".to_owned()
    } else if percent >= 80.0 {
        "warning".to_owned()
    } else {
        "normal".to_owned()
    }
}

/// Percent for display: clamped to the bar's range and rounded to a whole
/// number so the snapshot compares cleanly.
fn round_percent(percent: f64) -> i64 {
    percent.clamp(0.0, 100.0).round() as i64
}

fn title_case_words(value: &str) -> String {
    value
        .split(['_', '-', ' '])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Protobuf-over-JSON renders 64-bit ints as strings; plain JSON does not.
fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

fn epoch_seconds_from_rfc3339(text: &str) -> Option<i64> {
    crate::chat_transcript::parse_rfc3339_ms(text).map(|ms| (ms / 1000) as i64)
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::EnvGuard;
    use std::sync::mpsc;

    fn usage(status: &str) -> Vec<ProviderUsageReport> {
        vec![ProviderUsageReport::new("claude", "Claude Code", status, 0)]
    }

    fn statuses(reports: &[ProviderUsageReport]) -> Vec<&str> {
        reports
            .iter()
            .map(|report| report.status.as_str())
            .collect()
    }

    /// A read whose collection is held open until `release` fires.
    fn held_read(
        cache: &'static UsageCache,
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    ) -> std::thread::JoinHandle<(Vec<ProviderUsageReport>, i64)> {
        std::thread::spawn(move || {
            cache.snapshot(
                false,
                || 100,
                || {
                    started.send(()).unwrap();
                    release.recv().unwrap();
                    usage("older")
                },
            )
        })
    }

    fn leaked_cache() -> &'static UsageCache {
        Box::leak(Box::new(UsageCache::new()))
    }

    #[test]
    fn concurrent_reads_share_one_collection() {
        let cache = leaked_cache();
        let (started_tx, started) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let first = held_read(cache, started_tx, release_rx);
        started.recv().unwrap();

        // The clock runs under the cache lock, and the first read needs that
        // lock to finish, so releasing it after this signal cannot beat the
        // second read to its wait.
        let (reading_tx, reading) = mpsc::channel();
        let second = std::thread::spawn(move || {
            cache.snapshot(
                false,
                || {
                    reading_tx.send(()).unwrap();
                    100
                },
                || usage("duplicate"),
            )
        });
        reading.recv().unwrap();
        release.send(()).unwrap();

        assert_eq!(statuses(&first.join().unwrap().0), ["older"]);
        assert_eq!(statuses(&second.join().unwrap().0), ["older"]);
    }

    #[test]
    fn an_older_collection_cannot_replace_a_newer_one() {
        let cache = leaked_cache();
        let (started_tx, started) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let slow_read = held_read(cache, started_tx, release_rx);
        started.recv().unwrap();

        let (refreshed, collected_at) = cache.snapshot(true, || 105, || usage("newer"));
        assert_eq!(statuses(&refreshed), ["newer"]);
        release.send(()).unwrap();

        // The slow read hands back the newer snapshot, and the cache keeps it.
        assert_eq!(slow_read.join().unwrap(), (refreshed, collected_at));
        let (cached, cached_at) = cache.snapshot(false, || 106, || usage("unexpected"));
        assert_eq!(statuses(&cached), ["newer"]);
        assert_eq!(cached_at, 105);
    }

    #[test]
    fn refresh_and_an_expired_snapshot_collect_again() {
        let cache = UsageCache::new();
        cache.snapshot(false, || 100, || usage("first"));

        let (fresh, _) = cache.snapshot(false, || 159, || usage("unexpected"));
        assert_eq!(statuses(&fresh), ["first"]);
        let (refreshed, _) = cache.snapshot(true, || 159, || usage("refreshed"));
        assert_eq!(statuses(&refreshed), ["refreshed"]);
        let (expired, _) = cache.snapshot(false, || 219, || usage("expired"));
        assert_eq!(statuses(&expired), ["expired"]);
    }

    #[test]
    fn a_panicked_collection_does_not_strand_a_waiting_read() {
        let cache = leaked_cache();
        let (started_tx, started) = mpsc::channel();
        let (release, release_rx) = mpsc::channel::<()>();
        let panicking = std::thread::spawn(move || {
            cache.snapshot(
                false,
                || 100,
                || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    panic!("probe blew up");
                },
            )
        });
        started.recv().unwrap();

        let (reading_tx, reading) = mpsc::channel();
        let waiting = std::thread::spawn(move || {
            cache.snapshot(
                false,
                || {
                    let _ = reading_tx.send(());
                    100
                },
                || usage("recovered"),
            )
        });
        reading.recv().unwrap();
        release.send(()).unwrap();

        assert!(panicking.join().is_err());
        assert_eq!(statuses(&waiting.join().unwrap().0), ["recovered"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_keychain_lookup_past_its_deadline_is_stopped_and_reported() {
        let mut lookup = Command::new("sleep");
        lookup.arg("30");
        let started = Instant::now();

        let err = keychain_output(&mut lookup, Duration::from_millis(100)).unwrap_err();

        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(err.to_string().contains("did not answer"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_keychain_lookup_that_ends_reports_what_it_found() {
        let mut found = Command::new("sh");
        found.args(["-c", "printf secret"]);
        let mut missing = Command::new("sh");
        missing.args(["-c", "exit 44"]);
        let timeout = Duration::from_secs(10);

        assert_eq!(
            keychain_output(&mut found, timeout).unwrap().as_deref(),
            Some("secret")
        );
        assert_eq!(keychain_output(&mut missing, timeout).unwrap(), None);
    }

    #[test]
    fn a_failed_keychain_lookup_is_a_claude_error_beside_the_other_providers() {
        fn timed_out() -> ProviderUsageReport {
            claude_usage_with(Err(anyhow::anyhow!("Keychain did not answer")), 0)
        }
        fn answered() -> ProviderUsageReport {
            ProviderUsageReport::new("codex", "Codex", "ok", 0)
        }

        let reports = collect_from(vec![("claude", timed_out), ("codex", answered)]);

        assert_eq!(statuses(&reports), ["error", "ok"]);
        assert!(reports[0]
            .message
            .as_deref()
            .is_some_and(|message| message.contains("Keychain did not answer")));
    }

    #[test]
    fn an_anthropic_api_key_has_no_plan_quota_rather_than_no_sign_in() {
        let mut env = EnvGuard::lock();
        env.remove("ANTHROPIC_API_KEY");
        assert_eq!(claude_usage_with(Ok(None), 0).status, "unauthenticated");

        env.set("ANTHROPIC_API_KEY", "test-anthropic");
        let report = claude_usage_with(Ok(None), 0);
        drop(env);

        assert_eq!(report.status, "unsupported");
        assert!(report.manage_url.is_some());
    }

    #[test]
    fn an_openai_api_key_has_no_plan_quota_rather_than_no_sign_in() {
        let mut env = EnvGuard::lock();
        let home = tempfile::tempdir().unwrap();
        env.set("HOME", home.path());
        env.set("USERPROFILE", home.path());
        env.remove("OPENAI_API_KEY");
        env.remove("OPENAI_API_TOKEN");
        assert_eq!(codex_usage().status, "unauthenticated");

        for key in ["OPENAI_API_KEY", "OPENAI_API_TOKEN"] {
            env.set(key, "test-openai");
            let report = codex_usage();
            env.remove(key);

            assert_eq!(report.status, "unsupported", "{key}");
            assert_eq!(report, codex_api_key_report(report.checked_at), "{key}");
        }
    }

    #[test]
    fn claude_usage_reads_every_active_window() {
        let body = r#"{
            "limits": [
                {"kind":"weekly_all","group":"weekly","percent":38,"severity":"normal","resets_at":"2026-11-09T04:00:00.103098+00:00","scope":null,"is_active":true},
                {"kind":"weekly_scoped","group":"weekly","percent":15,"severity":"normal","resets_at":"2026-11-09T03:59:59+00:00","scope":{"model":{"id":null,"display_name":"Fable"}},"is_active":false}
            ],
            "extra_usage": {"is_enabled": false, "monthly_limit": 5000, "used_credits": 0.0, "utilization": 0.0}
        }"#;

        let meters = parse_claude_usage(body, 0).expect("parse");

        assert_eq!(meters.len(), 2);
        assert_eq!(meters[0].label, "This week");
        assert_eq!(meters[0].percent_used, 38);
        assert_eq!(meters[0].severity, "normal");
        assert_eq!(meters[0].resets_at, Some(1_794_196_800));
        assert_eq!(meters[1].label, "Fable");
        assert_eq!(meters[1].percent_used, 15);
    }

    #[test]
    fn claude_usage_adds_extra_credits_only_when_enabled() {
        let body = r#"{"limits":[],"extra_usage":{"is_enabled":true,"monthly_limit":5000,"used_credits":12.5,"utilization":25.0}}"#;

        let meters = parse_claude_usage(body, 0).expect("parse");

        assert_eq!(meters.len(), 1);
        assert_eq!(meters[0].label, "Extra usage");
        assert_eq!(meters[0].percent_used, 25);
        assert_eq!(
            meters[0].detail.as_deref(),
            Some("$12.50 of $50.00 this month")
        );
    }

    #[test]
    fn claude_severity_escalates_when_the_provider_stays_quiet() {
        let body = r#"{"limits":[{"kind":"five_hour","percent":97.0,"resets_at":null}]}"#;

        let meters = parse_claude_usage(body, 0).expect("parse");

        assert_eq!(meters[0].label, "Current session");
        assert_eq!(meters[0].severity, "critical");
    }

    #[test]
    fn claude_credentials_keep_the_token_but_expose_the_plan() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"sk-token","subscriptionType":"max"}}"#;

        let credentials = parse_claude_credentials(raw).expect("credentials");

        assert_eq!(credentials.access_token, "sk-token");
        assert_eq!(credentials.plan.as_deref(), Some("Max"));
    }

    #[test]
    fn claude_request_keeps_the_token_out_of_argv() {
        let request = claude_usage_request("sk-secret");

        assert!(!request.args.iter().any(|arg| arg.contains("sk-secret")));
        assert!(request.stdin.contains("sk-secret"));
    }

    #[test]
    fn codex_api_key_auth_has_no_plan_quota() {
        assert_eq!(
            parse_codex_auth(r#"{"auth_mode":"api_key","OPENAI_API_KEY":"sk-live"}"#),
            CodexAuth::ApiKey
        );
        assert_eq!(parse_codex_auth("{}"), CodexAuth::None);
        assert_eq!(
            parse_codex_auth(r#"{"tokens":{"access_token":"at","account_id":"acct"}}"#),
            CodexAuth::ChatGpt {
                access_token: "at".to_owned(),
                account_id: Some("acct".to_owned())
            }
        );
    }

    #[test]
    fn codex_usage_names_windows_by_length() {
        let body = r#"{"rate_limits":{"primary":{"used_percent":12.5,"window_minutes":300,"resets_in_seconds":600},"secondary":{"used_percent":44.0,"window_minutes":10080,"resets_in_seconds":7200}}}"#;

        let meters = parse_codex_usage(body, 1_000).expect("parse");

        assert_eq!(meters.len(), 2);
        assert_eq!(meters[0].label, "Current 5h window");
        assert_eq!(meters[0].percent_used, 13);
        assert_eq!(meters[0].resets_at, Some(1_600));
        assert_eq!(meters[1].label, "This week");
        assert_eq!(meters[1].resets_at, Some(8_200));
    }

    #[test]
    fn codex_usage_tolerates_a_wrapped_payload() {
        let body = r#"{"usage":{"rate_limits":{"primary":{"used_percent":5.0}}},"plan_type":"chatgpt_plus"}"#;

        let meters = parse_codex_usage(body, 0).expect("parse");

        assert_eq!(meters.len(), 1);
        assert_eq!(meters[0].label, "Current window");
        assert_eq!(parse_codex_plan(body).as_deref(), Some("Chatgpt Plus"));
    }

    #[test]
    fn devin_remaining_percent_becomes_percent_used() {
        let body = r#"{"userStatus":{"planStatus":{
            "planInfo":{"planName":"Teams"},
            "dailyQuotaRemainingPercent":97,
            "weeklyQuotaRemainingPercent":65,
            "dailyQuotaResetAtUnix":"1793952000",
            "weeklyQuotaResetAtUnix":"1794124800",
            "acuConsumed":35,
            "acuLimit":100
        }}}"#;

        let usage = parse_devin_usage(body).expect("parse");

        assert_eq!(usage.plan.as_deref(), Some("Teams"));
        assert_eq!(usage.meters.len(), 3);
        assert_eq!(usage.meters[0].label, "Today");
        assert_eq!(usage.meters[0].percent_used, 3);
        assert_eq!(usage.meters[0].resets_at, Some(1_793_952_000));
        assert_eq!(usage.meters[1].label, "This week");
        assert_eq!(usage.meters[1].percent_used, 35);
        assert_eq!(usage.meters[2].label, "ACUs");
        assert_eq!(usage.meters[2].percent_used, 35);
        assert_eq!(usage.meters[2].detail.as_deref(), Some("35 of 100 ACUs"));
    }

    #[test]
    fn devin_request_keeps_the_api_key_out_of_argv() {
        let request = devin_usage_request("key-secret", "https://server.codeium.com");

        assert!(!request.args.iter().any(|arg| arg.contains("key-secret")));
        assert!(request.stdin.contains("key-secret"));
        assert!(request.stdin.contains(
            "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus"
        ));
        // Devin's server rejects a non-semver client version with a 500.
        let version_parts = env!("CARGO_PKG_VERSION").split('.').count();
        assert_eq!(version_parts, 3);
        assert!(request.stdin.contains(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn devin_credentials_fall_back_to_the_public_api_server() {
        let credentials =
            parse_devin_credentials("windsurf_api_key = \"key\"\n").expect("credentials");

        assert_eq!(credentials.api_key, "key");
        assert_eq!(credentials.api_server_url, "https://server.codeium.com");
    }

    #[test]
    fn missing_plan_status_is_an_error_not_an_empty_report() {
        assert!(parse_devin_usage(r#"{"userStatus":{}}"#).is_err());
    }
}
