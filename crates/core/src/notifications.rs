use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, warn};

use crate::archcar::protocol::ArchcarEvent;
use crate::background_tasks::BackgroundTask;
use crate::provider_interactions::ProviderInteractionRecord;

const DEFAULT_APNS_TOPIC: &str = "ai.perceo.archductor.ios";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationDevice {
    pub id: i64,
    pub platform: String,
    pub token: String,
    pub app_bundle: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventNotification {
    pub id: String,
    pub title: String,
    pub body: String,
    pub thread_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApnsConfig {
    pub team_id: String,
    pub key_id: String,
    pub key_path: PathBuf,
    pub topic: String,
    pub endpoint: String,
}

pub struct NotificationDeviceStore {
    db_path: PathBuf,
}

impl NotificationDeviceStore {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
        }
    }

    pub fn register(
        &self,
        platform: &str,
        token: &str,
        app_bundle: &str,
    ) -> Result<NotificationDevice> {
        let platform = platform.trim();
        let token = token.trim();
        let app_bundle = app_bundle.trim();
        if platform.is_empty() {
            bail!("notification platform is required");
        }
        if token.is_empty() {
            bail!("notification device token is required");
        }
        if app_bundle.is_empty() {
            bail!("notification app bundle is required");
        }

        let now = timestamp();
        let conn = self.open()?;
        conn.execute(
            "INSERT INTO notification_devices (platform, token, app_bundle, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(token) DO UPDATE SET
               platform = excluded.platform,
               app_bundle = excluded.app_bundle,
               updated_at = excluded.updated_at",
            params![platform, token, app_bundle, now],
        )?;
        self.get_by_token(token)?
            .ok_or_else(|| anyhow!("notification device was not stored"))
    }

    /// Drop every registration. Token rotation is documented as "revoke a
    /// phone": a revoked phone must stop receiving pushes even though APNs
    /// itself would still accept its device token. Connected phones re-register
    /// the next time they pair with the new daemon token.
    pub fn clear(&self) -> Result<usize> {
        let conn = self.open()?;
        let removed = conn.execute("DELETE FROM notification_devices", [])?;
        Ok(removed)
    }

    pub fn list(&self) -> Result<Vec<NotificationDevice>> {
        let conn = self.open()?;
        let mut stmt = conn.prepare(
            "SELECT id, platform, token, app_bundle, created_at, updated_at
             FROM notification_devices
             ORDER BY updated_at DESC, id DESC",
        )?;
        let rows = stmt.query_map([], row_to_device)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn get_by_token(&self, token: &str) -> Result<Option<NotificationDevice>> {
        self.open()?
            .query_row(
                "SELECT id, platform, token, app_bundle, created_at, updated_at
                 FROM notification_devices
                 WHERE token = ?1",
                params![token],
                row_to_device,
            )
            .optional()
            .map_err(Into::into)
    }

    fn open(&self) -> Result<Connection> {
        // Token rotation can run before the daemon has ever created the data
        // dir (fresh install, CLI-only host); opening must not fail on that.
        if let Some(parent) = self.db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&self.db_path)?;
        crate::storage::migrate_workspace_db(&conn)?;
        Ok(conn)
    }
}

/// The daemon's stable self-id: minted once on first use and persisted in
/// `state.db`, then returned unchanged for the life of that data directory.
/// Used to stamp outgoing APNs pushes so a tap can tell which daemon it came
/// from, and reported to clients over the `list_repositories` handshake so
/// they can learn it.
pub fn daemon_self_id(db_path: &Path) -> Result<String> {
    let conn = NotificationDeviceStore::new(db_path).open()?;
    let select = |conn: &Connection| {
        conn.query_row(
            "SELECT self_id FROM daemon_identity WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
    };
    if let Some(existing) = select(&conn).optional()? {
        return Ok(existing);
    }
    // INSERT OR IGNORE: two racing first boots must not error and must agree
    // on one winner, so re-select rather than trusting the id minted here.
    conn.execute(
        "INSERT OR IGNORE INTO daemon_identity (id, self_id, created_at) VALUES (1, ?1, ?2)",
        params![uuid::Uuid::new_v4().to_string(), timestamp()],
    )?;
    Ok(select(&conn)?)
}

/// What the surfaces already know about the chat an event names, so a
/// notification can read "antix · fix the parser / Done in 4m 12s" instead of
/// "Chat finished / Thread 9 completed.". Every field is optional: a missing
/// one only costs detail, never the notification.
///
/// The wording built from it is mirrored by
/// `EventNotificationDescriptor` (iOS) and `eventNotifications.ts` (desktop),
/// which render the local copy of the same event. Change all three together.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NotificationContext<'a> {
    pub workspace: Option<&'a str>,
    pub chat_title: Option<&'a str>,
    /// The model the chat runs, when recorded; `provider` is the fallback.
    pub model: Option<&'a str>,
    pub provider: Option<&'a str>,
}

/// Longest chat title kept in a notification title. Past this the rest of the
/// line (the workspace, which says *where*) is what gets pushed off screen.
const CHAT_TITLE_MAX: usize = 44;
/// Longest body. macOS shows roughly two lines, iOS three; past this a
/// notification is a wall of text nobody reads at a glance.
const BODY_MAX: usize = 120;

pub fn event_notification(event: &ArchcarEvent) -> Option<EventNotification> {
    event_notification_in(event, NotificationContext::default())
}

/// Builds the notification for `event` in `context`.
fn event_notification_in(
    event: &ArchcarEvent,
    context: NotificationContext<'_>,
) -> Option<EventNotification> {
    match event {
        ArchcarEvent::ProviderInteractionRequested { interaction } => {
            Some(interaction_notification(interaction, context))
        }
        ArchcarEvent::TurnCompleted {
            session_id,
            thread_id,
            status,
            duration_ms,
        } => {
            let status = status.as_deref().map(str::trim).unwrap_or("completed");
            let status = if status.is_empty() {
                "completed"
            } else {
                status
            };
            Some(EventNotification {
                id: format!("turn-{session_id}-{thread_id}-{status}"),
                title: chat_headline(context, Some(*thread_id)),
                body: turn_body(status, *duration_ms, context),
                thread_id: Some(*thread_id),
            })
        }
        ArchcarEvent::SessionError {
            session_id,
            thread_id,
            message,
        } => Some(EventNotification {
            id: format!(
                "session-error-{}-{}",
                session_id
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| "unknown".to_owned()),
                thread_id
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| "unknown".to_owned())
            ),
            title: chat_headline(context, *thread_id),
            body: truncated(&prefixed_detail("Failed", message), BODY_MAX),
            thread_id: *thread_id,
        }),
        ArchcarEvent::BackgroundTaskUpdated { task } => background_task_notification(task),
        _ => None,
    }
}

/// The notification title: which chat this is about, as
/// "workspace · chat title". Falls back through whichever half is known, and
/// to the thread number when neither is.
fn chat_headline(context: NotificationContext<'_>, thread_id: Option<i64>) -> String {
    let workspace = nonempty(context.workspace);
    let chat_title = nonempty(context.chat_title).map(|title| truncated(title, CHAT_TITLE_MAX));
    match (workspace, chat_title) {
        (Some(workspace), Some(title)) => format!("{workspace} · {title}"),
        (Some(workspace), None) => workspace.to_owned(),
        (None, Some(title)) => title,
        (None, None) => match thread_id {
            Some(thread_id) => format!("Thread {thread_id}"),
            None => "Archductor".to_owned(),
        },
    }
}

/// "Done in 4m 12s · Claude Opus 5": what happened, how long it took, who ran
/// it. Enough to decide whether to go back to this chat without opening it.
fn turn_body(status: &str, duration_ms: Option<u64>, context: NotificationContext<'_>) -> String {
    let (label, preposition) = turn_outcome(status);
    let mut body = match duration_ms {
        Some(duration_ms) => format!(
            "{label} {preposition} {}",
            crate::provider_projection::format_provider_turn_duration(duration_ms)
        ),
        None => label,
    };
    if let Some(agent) = agent_label(context) {
        body.push_str(" · ");
        body.push_str(&agent);
    }
    truncated(&body, BODY_MAX)
}

/// How a finished turn reads, and the preposition its duration needs. An
/// unknown status is shown as it arrived rather than being flattened into
/// "stopped", which is what made every successful claude turn ("success")
/// read as a failure.
fn turn_outcome(status: &str) -> (String, &'static str) {
    match status.to_ascii_lowercase().as_str() {
        "completed" | "success" | "succeeded" | "ok" => ("Done".to_owned(), "in"),
        "failed" | "error" | "errored" => ("Failed".to_owned(), "after"),
        "interrupted" | "cancelled" | "canceled" | "stopped" | "aborted" => {
            ("Stopped".to_owned(), "after")
        }
        "deferred" | "queued" | "paused" => ("Paused".to_owned(), "after"),
        other => (capitalized(other), "after"),
    }
}

/// Who ran the turn: the model when the chat records one, else the provider.
fn agent_label(context: NotificationContext<'_>) -> Option<String> {
    if let Some(model) = nonempty(context.model) {
        return Some(model_label(model));
    }
    nonempty(context.provider).map(capitalized)
}

/// `modelLabel` in the desktop app, which is the source of truth, and
/// `AgentModels.label` on iOS. `tests/fixtures/model_labels.json` holds all
/// three to the same answers.
fn model_label(model: &str) -> String {
    match model {
        "gpt-5.6-sol" => return "GPT 5.6 Sol".to_owned(),
        "gpt-5.6-terra" => return "GPT 5.6 Terra".to_owned(),
        "gpt-5.6-luna" => return "GPT 5.6 Luna".to_owned(),
        "gpt-5.5" => return "GPT 5.5".to_owned(),
        "gpt-5.4" => return "GPT 5.4".to_owned(),
        "claude-opus-4-8[1m]" => return "Claude Opus 4.8 1M".to_owned(),
        "claude-opus-4-7[1m]" => return "Claude Opus 4.7 1M".to_owned(),
        "claude-opus-4-6[1m]" => return "Claude Opus 4.6 1M".to_owned(),
        "claude-sonnet-5" => return "Claude Sonnet 5 1M".to_owned(),
        "claude-sonnet-4-6[1m]" => return "Claude Sonnet 4.6 1M".to_owned(),
        "claude-sonnet-4-6" => return "Claude Sonnet 4.6".to_owned(),
        "claude-haiku-4-5" => return "Claude Haiku 4.5".to_owned(),
        _ => {}
    }
    let (base, long_context) = match model.strip_suffix("[1m]") {
        Some(base) => (base, true),
        None => (model, false),
    };
    let mut parts: Vec<String> = base
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            if part.eq_ignore_ascii_case("gpt") {
                "GPT".to_owned()
            } else {
                capitalized(part)
            }
        })
        .collect();
    if long_context {
        parts.push("1M".to_owned());
    }
    parts.join(" ")
}

fn capitalized(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// "Failed: codex exited" - the lead says what kind of event this is, the
/// detail says what to do about it.
fn prefixed_detail(lead: &str, detail: &str) -> String {
    let detail = collapsed(detail);
    if detail.is_empty() {
        lead.to_owned()
    } else {
        format!("{lead}: {detail}")
    }
}

/// Notification bodies are one line of plain text: a wrapped agent message or
/// a multi-line error renders as a ragged block, so whitespace is collapsed
/// before anything is measured or cut.
fn collapsed(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Cuts at a word boundary, so a clipped line ends "so every\u{2026}" rather
/// than "so every s\u{2026}". Falls back to a hard cut for a single long word
/// (a path, a URL) that has no boundary to fall back to.
fn truncated(value: &str, max: usize) -> String {
    let value = collapsed(value);
    if value.chars().count() <= max {
        return value;
    }
    let kept: String = value.chars().take(max.saturating_sub(1)).collect();
    let next_is_boundary = value
        .chars()
        .nth(max.saturating_sub(1))
        .is_some_and(char::is_whitespace);
    let kept = match (next_is_boundary, kept.rfind(char::is_whitespace)) {
        (false, Some(boundary)) if boundary > 0 => &kept[..boundary],
        _ => kept.as_str(),
    };
    format!("{}\u{2026}", kept.trim_end())
}

pub fn notify_event(db_path: PathBuf, event: ArchcarEvent) {
    let thread_id = match &event {
        ArchcarEvent::TurnCompleted { thread_id, .. } => Some(*thread_id),
        ArchcarEvent::SessionError { thread_id, .. } => *thread_id,
        ArchcarEvent::ProviderInteractionRequested { interaction } => Some(interaction.thread_id),
        _ => None,
    };
    let chat = thread_id.and_then(|thread_id| chat_context(&db_path, thread_id));
    let context = chat
        .as_ref()
        .map(|chat| NotificationContext {
            workspace: Some(chat.workspace.as_str()),
            chat_title: Some(chat.title.as_str()),
            model: chat.model.as_deref(),
            provider: Some(chat.provider.as_str()),
        })
        .unwrap_or_default();
    let Some(notification) = event_notification_in(&event, context) else {
        return;
    };
    let Some(config) = ApnsConfig::from_env() else {
        debug!("APNs config missing; remote notification skipped");
        return;
    };
    if let Err(err) = send_apns_notification(&db_path, &config, &notification) {
        warn!("APNs notification failed: {err:#}");
    }
}

/// What a push can say about the chat an event names, beyond its row id.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ChatContext {
    workspace: String,
    title: String,
    provider: String,
    model: Option<String>,
}

/// The workspace, title, provider and model of the chat that owns
/// `thread_id`, so a push reads "antix · fix the parser / Done in 4m 12s".
/// A missing database or row only costs the nicer wording, never the push.
fn chat_context(db_path: &Path, thread_id: i64) -> Option<ChatContext> {
    let lookup = || -> Result<Option<ChatContext>> {
        let conn =
            Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.query_row(
            "SELECT w.name, t.title, t.provider, t.model
               FROM chat_threads t JOIN workspaces w ON w.id = t.workspace_id
              WHERE t.id = ?1",
            params![thread_id],
            |row| {
                Ok(ChatContext {
                    workspace: row.get(0)?,
                    title: row.get(1)?,
                    provider: row.get(2)?,
                    model: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    };
    lookup().unwrap_or_else(|err| {
        debug!("chat lookup for thread {thread_id} failed: {err:#}");
        None
    })
}

pub fn send_apns_notification(
    db_path: &Path,
    config: &ApnsConfig,
    notification: &EventNotification,
) -> Result<usize> {
    let devices = NotificationDeviceStore::new(db_path).list()?;
    let jwt = apns_jwt(config)?;
    // Never block the push on the id: an unstamped push routes the way it
    // did before stamping existed.
    let daemon_self_id = match daemon_self_id(db_path) {
        Ok(id) => Some(id),
        Err(err) => {
            warn!("daemon self id unavailable, sending push without it: {err:#}");
            None
        }
    };
    let payload = notification_payload(notification, daemon_self_id.as_deref());
    let mut sent = 0usize;
    for device in devices
        .iter()
        .filter(|device| device.platform == "ios" && device.app_bundle == config.topic)
    {
        match send_apns_to_device(config, &jwt, &payload, &device.token).with_context(|| {
            format!(
                "send APNs notification to token {}",
                redacted_token(&device.token)
            )
        }) {
            Ok(()) => sent += 1,
            Err(err) => warn!("{err:#}"),
        }
    }
    Ok(sent)
}

impl ApnsConfig {
    pub fn from_env() -> Option<Self> {
        let team_id = std::env::var("ARCHDUCTOR_APNS_TEAM_ID").ok()?;
        let key_id = std::env::var("ARCHDUCTOR_APNS_KEY_ID").ok()?;
        let key_path = PathBuf::from(std::env::var("ARCHDUCTOR_APNS_KEY_PATH").ok()?);
        let topic = std::env::var("ARCHDUCTOR_APNS_TOPIC")
            .unwrap_or_else(|_| DEFAULT_APNS_TOPIC.to_owned());
        // The environment must be chosen explicitly. Defaulting to the
        // sandbox silently strands Release builds: they register production
        // device tokens, and the sandbox endpoint will never reach them.
        let endpoint = match std::env::var("ARCHDUCTOR_APNS_ENDPOINT").ok() {
            Some(endpoint) => endpoint,
            None => match std::env::var("ARCHDUCTOR_APNS_ENV").as_deref() {
                Ok("production") => "https://api.push.apple.com".to_owned(),
                Ok("development") | Ok("sandbox") => {
                    "https://api.sandbox.push.apple.com".to_owned()
                }
                Ok(other) => {
                    warn!(
                        "ARCHDUCTOR_APNS_ENV must be \"production\", \"development\", or \"sandbox\" (got {other:?}); APNs disabled"
                    );
                    return None;
                }
                Err(_) => {
                    warn!(
                        "APNs signing settings are present but ARCHDUCTOR_APNS_ENV is unset; set it to \"production\" or \"development\" (APNs disabled until then)"
                    );
                    return None;
                }
            },
        };
        Some(Self {
            team_id,
            key_id,
            key_path,
            topic,
            endpoint,
        })
    }
}

fn interaction_notification(
    interaction: &ProviderInteractionRecord,
    context: NotificationContext<'_>,
) -> EventNotification {
    // The interaction carries its own workspace; the chat title and agent
    // come from the surface's inventory, when it has one.
    let context = NotificationContext {
        workspace: nonempty(Some(interaction.workspace.as_str())).or(context.workspace),
        provider: nonempty(Some(interaction.provider_key.as_str())).or(context.provider),
        ..context
    };
    EventNotification {
        id: format!("interaction-{}", interaction.id),
        title: chat_headline(context, Some(interaction.thread_id)),
        body: truncated(
            &prefixed_detail(
                "Needs you",
                &joined_detail(&interaction.title, &interaction.detail),
            ),
            BODY_MAX,
        ),
        thread_id: Some(interaction.thread_id),
    }
}

/// "Approve command? - cargo test": the ask, then what it is about.
fn joined_detail(title: &str, detail: &str) -> String {
    let title = collapsed(title);
    let detail = collapsed(detail);
    if title.is_empty() {
        return detail;
    }
    if detail.is_empty() {
        return title;
    }
    format!("{title} \u{2014} {detail}")
}

fn background_task_notification(task: &BackgroundTask) -> Option<EventNotification> {
    if task.status != "ready" && task.status != "failed" {
        return None;
    }
    let detail = if task.detail.trim().is_empty() {
        task.error.as_deref().unwrap_or("")
    } else {
        task.detail.as_str()
    };
    Some(EventNotification {
        id: format!("background-task-{}-{}", task.id, task.status),
        title: chat_headline(
            NotificationContext {
                workspace: nonempty(task.workspace_name.as_deref()),
                chat_title: nonempty(Some(task.title.as_str())),
                ..NotificationContext::default()
            },
            None,
        ),
        body: truncated(
            &prefixed_detail(
                if task.status == "ready" {
                    "Task ready"
                } else {
                    "Task failed"
                },
                detail,
            ),
            BODY_MAX,
        ),
        thread_id: None,
    })
}

fn notification_payload(notification: &EventNotification, daemon_self_id: Option<&str>) -> String {
    let mut payload = json!({
        "aps": {
            "alert": {
                "title": notification.title,
                "body": notification.body,
            },
            "sound": "default",
        },
        "notification_id": notification.id,
    });
    if let Some(thread_id) = notification.thread_id {
        payload["thread_id"] = json!(thread_id);
    }
    // `thread_id` is a per-daemon rowid; this says which daemon it belongs
    // to. Omitted rather than null when unknown, so older clients see the
    // payload they always did.
    if let Some(daemon_self_id) = daemon_self_id {
        payload["daemon_self_id"] = json!(daemon_self_id);
    }
    payload.to_string()
}

fn send_apns_to_device(config: &ApnsConfig, jwt: &str, payload: &str, token: &str) -> Result<()> {
    let url = format!(
        "{}/3/device/{}",
        config.endpoint.trim_end_matches('/'),
        token
    );
    let curl_config = format!(
        "url = \"{}\"\nrequest = \"POST\"\nheader = \"authorization: bearer {}\"\nheader = \"apns-topic: {}\"\nheader = \"apns-push-type: alert\"\nheader = \"content-type: application/json\"\ndata = \"{}\"\n",
        curl_config_escape(&url),
        curl_config_escape(jwt),
        curl_config_escape(&config.topic),
        curl_config_escape(payload),
    );
    let mut child = Command::new("curl")
        .arg("--silent")
        .arg("--show-error")
        .arg("--http2")
        // One notification per thread: a stalled APNs connection must release
        // the thread rather than pile up blocked curl children.
        .arg("--connect-timeout")
        .arg("10")
        .arg("--max-time")
        .arg("30")
        .arg("--write-out")
        .arg("\n%{http_code}")
        .arg("--config")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn curl for APNs")?;
    child
        .stdin
        .as_mut()
        .context("open APNs curl config stdin")?
        .write_all(curl_config.as_bytes())
        .context("write APNs curl config")?;
    let output = child.wait_with_output().context("wait for APNs curl")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        bail!("curl exited {}: {}", output.status, stderr.trim());
    }
    let Some((body, status)) = stdout.rsplit_once('\n') else {
        bail!("APNs response omitted HTTP status: {}", stdout.trim());
    };
    let status = status.trim().parse::<u16>().unwrap_or(0);
    if (200..300).contains(&status) {
        return Ok(());
    }
    bail!("APNs returned HTTP {status}: {}", body.trim());
}

fn apns_jwt(config: &ApnsConfig) -> Result<String> {
    let header = json!({ "alg": "ES256", "kid": config.key_id });
    let claims = json!({ "iss": config.team_id, "iat": unix_seconds() });
    let signing_input = format!(
        "{}.{}",
        base64_url(header.to_string().as_bytes()),
        base64_url(claims.to_string().as_bytes())
    );
    let der = openssl_sign(&config.key_path, signing_input.as_bytes())?;
    let raw = ecdsa_der_to_raw(&der)?;
    Ok(format!("{}.{}", signing_input, base64_url(&raw)))
}

fn openssl_sign(key_path: &Path, message: &[u8]) -> Result<Vec<u8>> {
    let mut child = Command::new("openssl")
        .arg("dgst")
        .arg("-sha256")
        .arg("-sign")
        .arg(key_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("spawn openssl")?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| anyhow!("openssl stdin unavailable"))?
        .write_all(message)?;
    let output = child.wait_with_output()?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        bail!(
            "openssl exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )
    }
}

fn ecdsa_der_to_raw(der: &[u8]) -> Result<[u8; 64]> {
    if der.len() < 8 || der[0] != 0x30 {
        bail!("invalid ECDSA DER signature");
    }
    let mut index = if der[1] & 0x80 == 0 {
        2
    } else {
        2 + (der[1] & 0x7f) as usize
    };
    let r = read_der_integer(der, &mut index)?;
    let s = read_der_integer(der, &mut index)?;
    let mut raw = [0u8; 64];
    copy_padded(&r, &mut raw[..32])?;
    copy_padded(&s, &mut raw[32..])?;
    Ok(raw)
}

fn read_der_integer(der: &[u8], index: &mut usize) -> Result<Vec<u8>> {
    if der.get(*index) != Some(&0x02) {
        bail!("invalid ECDSA DER integer");
    }
    *index += 1;
    let len = *der
        .get(*index)
        .ok_or_else(|| anyhow!("truncated ECDSA DER integer"))? as usize;
    *index += 1;
    let value = der
        .get(*index..*index + len)
        .ok_or_else(|| anyhow!("truncated ECDSA DER integer"))?
        .to_vec();
    *index += len;
    Ok(value)
}

fn copy_padded(value: &[u8], target: &mut [u8]) -> Result<()> {
    let value = value.strip_prefix(&[0]).unwrap_or(value);
    if value.len() > target.len() {
        bail!("ECDSA signature integer too large");
    }
    let offset = target.len() - value.len();
    target[offset..].copy_from_slice(value);
    Ok(())
}

fn row_to_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<NotificationDevice> {
    Ok(NotificationDevice {
        id: row.get(0)?,
        platform: row.get(1)?,
        token: row.get(2)?,
        app_bundle: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn base64_url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn timestamp() -> String {
    unix_seconds().to_string()
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn redacted_token(token: &str) -> String {
    if token.len() <= 8 {
        "<redacted>".to_owned()
    } else {
        format!("{}…{}", &token[..4], &token[token.len() - 4..])
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archcar::harness_contract::ProviderInteractionKind;
    use crate::provider_interactions::{ProviderInteractionRecord, ProviderInteractionStatus};
    use serde_json::json;

    fn migrated_db() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let conn = Connection::open(&db_path).unwrap();
        crate::storage::migrate_workspace_db(&conn).unwrap();
        (temp, db_path)
    }

    #[test]
    fn registers_notification_devices_idempotently() {
        let (_temp, db_path) = migrated_db();
        let store = NotificationDeviceStore::new(db_path);

        let first = store
            .register("ios", "abc123", "ai.perceo.archductor.ios")
            .unwrap();
        let second = store
            .register("ios", "abc123", "ai.perceo.archductor.ios")
            .unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(second.platform, "ios");
    }

    #[test]
    fn apns_config_requires_an_explicit_environment() {
        let mut env = crate::test_support::EnvGuard::lock();
        let vars = [
            ("ARCHDUCTOR_APNS_TEAM_ID", Some("TEAM")),
            ("ARCHDUCTOR_APNS_KEY_ID", Some("KEY")),
            ("ARCHDUCTOR_APNS_KEY_PATH", Some("/tmp/AuthKey.p8")),
            ("ARCHDUCTOR_APNS_TOPIC", None),
            ("ARCHDUCTOR_APNS_ENDPOINT", None),
            ("ARCHDUCTOR_APNS_ENV", None),
        ];
        for (name, value) in vars {
            match value {
                Some(value) => env.set(name, value),
                None => env.remove(name),
            }
        }

        // Signing settings alone are not enough: without an environment the
        // daemon must stay silent rather than guess the sandbox and strand
        // production tokens.
        assert!(ApnsConfig::from_env().is_none());

        env.set("ARCHDUCTOR_APNS_ENV", "nonsense");
        assert!(ApnsConfig::from_env().is_none());

        env.set("ARCHDUCTOR_APNS_ENV", "development");
        assert_eq!(
            ApnsConfig::from_env().unwrap().endpoint,
            "https://api.sandbox.push.apple.com"
        );

        env.set("ARCHDUCTOR_APNS_ENV", "production");
        assert_eq!(
            ApnsConfig::from_env().unwrap().endpoint,
            "https://api.push.apple.com"
        );

        // An explicit endpoint override still wins.
        env.set("ARCHDUCTOR_APNS_ENDPOINT", "https://apns.test.local");
        assert_eq!(
            ApnsConfig::from_env().unwrap().endpoint,
            "https://apns.test.local"
        );
    }

    #[test]
    fn maps_events_to_push_notifications() {
        let interaction = ProviderInteractionRecord {
            id: "ask-1".to_owned(),
            provider_key: "claude".to_owned(),
            workspace: "checkout".to_owned(),
            thread_id: 9,
            session_id: 3,
            native_session_id: None,
            native_id: "native".to_owned(),
            kind: ProviderInteractionKind::Permission,
            title: "Approve command?".to_owned(),
            detail: "cargo test".to_owned(),
            questions: vec![],
            auto_resolution_ms: None,
            plan_path: None,
            native_request: json!({}),
            request_fingerprint: "fp".to_owned(),
            status: ProviderInteractionStatus::Pending,
            resolution: None,
            native_response: None,
            error: None,
            created_at: "1".to_owned(),
            resolved_at: None,
            consumed_at: None,
        };

        assert_eq!(
            event_notification(&ArchcarEvent::ProviderInteractionRequested { interaction }),
            Some(EventNotification {
                id: "interaction-ask-1".to_owned(),
                title: "checkout".to_owned(),
                body: "Needs you: Approve command? \u{2014} cargo test".to_owned(),
                thread_id: Some(9),
            })
        );
        // A good turn used to read "Chat stopped / The chat in X success."
        // because only the literal "completed" counted as success.
        let done = event_notification(&ArchcarEvent::TurnCompleted {
            session_id: 11,
            thread_id: 9,
            status: Some("success".to_owned()),
            duration_ms: Some(252_000),
        })
        .unwrap();
        assert_eq!(done.title, "Thread 9");
        assert_eq!(done.body, "Done in 4m 12s");
    }

    /// One table for every surface: `models.test.ts` and
    /// `AgentModelsTests.swift` read this same file, so a banner names a
    /// model the same way on the desktop, on a phone and in a push.
    #[test]
    fn model_labels_match_the_table_every_surface_shares() {
        let labels: std::collections::BTreeMap<String, String> =
            serde_json::from_str(include_str!("../tests/fixtures/model_labels.json")).unwrap();
        assert!(!labels.is_empty());
        for (model, label) in &labels {
            assert_eq!(&model_label(model), label, "label for {model}");
        }
    }

    #[test]
    fn turn_notifications_say_where_what_and_how_long() {
        let context = NotificationContext {
            workspace: Some("antix"),
            chat_title: Some("fix the parser"),
            model: Some("claude-opus-5"),
            provider: Some("claude"),
        };
        let turn = |status: &str, duration_ms: Option<u64>| {
            event_notification_in(
                &ArchcarEvent::TurnCompleted {
                    session_id: 11,
                    thread_id: 9,
                    status: Some(status.to_owned()),
                    duration_ms,
                },
                context,
            )
            .unwrap()
        };

        let done = turn("success", Some(252_000));
        assert_eq!(done.title, "antix \u{b7} fix the parser");
        assert_eq!(done.body, "Done in 4m 12s \u{b7} Claude Opus 5");
        // The id stays keyed on the status, so a retried turn replaces its
        // own banner instead of stacking a second one.
        assert_eq!(done.id, "turn-11-9-success");

        assert_eq!(
            turn("failed", Some(2_000)).body,
            "Failed after 2.0s \u{b7} Claude Opus 5"
        );
        assert_eq!(
            turn("interrupted", Some(18_300)).body,
            "Stopped after 18.3s \u{b7} Claude Opus 5"
        );
        // An older daemon sends no duration; the outcome still reads.
        assert_eq!(turn("success", None).body, "Done \u{b7} Claude Opus 5");
        // An unknown status is shown, not flattened into "stopped".
        assert_eq!(
            turn("rate_limited", Some(900)).body,
            "Rate_limited after 900ms \u{b7} Claude Opus 5"
        );

        // No model recorded: the provider names who ran it.
        assert_eq!(
            event_notification_in(
                &ArchcarEvent::TurnCompleted {
                    session_id: 11,
                    thread_id: 9,
                    status: Some("success".to_owned()),
                    duration_ms: Some(1_500),
                },
                NotificationContext {
                    model: None,
                    ..context
                },
            )
            .unwrap()
            .body,
            "Done in 1.5s \u{b7} Claude"
        );
    }

    #[test]
    fn long_titles_and_bodies_are_cut_to_one_glanceable_line() {
        let long_title = "refactor the provider projection so every surface agrees on turn ids";
        let notification = event_notification_in(
            &ArchcarEvent::TurnCompleted {
                session_id: 1,
                thread_id: 2,
                status: Some("success".to_owned()),
                duration_ms: Some(1_000),
            },
            NotificationContext {
                workspace: Some("antix"),
                chat_title: Some(long_title),
                ..NotificationContext::default()
            },
        )
        .unwrap();
        assert_eq!(
            notification.title,
            "antix \u{b7} refactor the provider projection so every\u{2026}"
        );

        // A multi-line error collapses to one line before it is cut.
        let error = event_notification_in(
            &ArchcarEvent::SessionError {
                session_id: Some(1),
                thread_id: Some(2),
                message: "codex exited\n\n  with status 1".to_owned(),
            },
            NotificationContext {
                workspace: Some("antix"),
                chat_title: Some("fix the parser"),
                ..NotificationContext::default()
            },
        )
        .unwrap();
        assert_eq!(error.title, "antix \u{b7} fix the parser");
        assert_eq!(error.body, "Failed: codex exited with status 1");
    }

    #[test]
    fn daemon_self_id_is_stable_across_restarts() {
        let (_temp, db_path) = migrated_db();
        let first = daemon_self_id(&db_path).unwrap();
        // Simulate a restart: nothing in-process is cached, re-derive from
        // the same data directory (same db_path) and expect the same id.
        let second = daemon_self_id(&db_path).unwrap();
        assert_eq!(first, second);
        assert!(!first.is_empty());

        // A different data directory must NOT share the id.
        let (_temp2, other_db_path) = migrated_db();
        let other = daemon_self_id(&other_db_path).unwrap();
        assert_ne!(first, other);
    }

    #[test]
    fn notification_payload_carries_the_daemon_self_id_when_present() {
        let notification = EventNotification {
            id: "turn-1-9-completed".to_owned(),
            title: "antix \u{b7} fix the parser".to_owned(),
            body: "Done in 4m 12s".to_owned(),
            thread_id: Some(9),
        };
        let with_id = notification_payload(&notification, Some("abc-123"));
        let parsed: serde_json::Value = serde_json::from_str(&with_id).unwrap();
        assert_eq!(parsed["daemon_self_id"], serde_json::json!("abc-123"));
        assert_eq!(parsed["thread_id"], serde_json::json!(9));

        // Absent id (lookup failed, or an older code path): field must be
        // omitted entirely, not null — an older client reading this JSON
        // must see exactly what it saw before this change.
        let without_id = notification_payload(&notification, None);
        let parsed_without: serde_json::Value = serde_json::from_str(&without_id).unwrap();
        assert!(parsed_without.get("daemon_self_id").is_none());
    }

    #[test]
    fn names_the_workspace_and_chat_that_own_the_thread() {
        let (_temp, db_path) = migrated_db();
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "INSERT INTO repositories (id, name, root_path, default_branch, workspace_parent_path, created_at, updated_at)
               VALUES (1, 'repo', '/repo', 'main', '/ws', '1', '1');
             INSERT INTO workspaces (id, repository_id, name, path, branch, base_ref, port_base, status, created_at, updated_at)
               VALUES (5, 1, 'checkout', '/ws/checkout', 'b', 'main', 4000, 'active', '1', '1');
             INSERT INTO chat_threads (id, workspace_id, provider, title, status, model, created_at, updated_at)
               VALUES (9, 5, 'claude', 'fix the parser', 'idle', 'claude-opus-5', '1', '1');",
        )
        .unwrap();

        let chat = chat_context(&db_path, 9).unwrap();
        assert_eq!(chat.workspace, "checkout");
        assert_eq!(chat.title, "fix the parser");
        assert_eq!(chat.provider, "claude");
        assert_eq!(chat.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(chat_context(&db_path, 404), None);
        assert_eq!(chat_context(&db_path.with_file_name("missing.db"), 9), None);

        let completed = ArchcarEvent::TurnCompleted {
            session_id: 11,
            thread_id: 9,
            status: Some("completed".to_owned()),
            duration_ms: Some(45_000),
        };
        assert_eq!(
            event_notification_in(
                &completed,
                NotificationContext {
                    workspace: Some(chat.workspace.as_str()),
                    chat_title: Some(chat.title.as_str()),
                    model: chat.model.as_deref(),
                    provider: Some(chat.provider.as_str()),
                },
            )
            .unwrap()
            .title,
            "checkout \u{b7} fix the parser"
        );
        // Nothing resolved: the thread number is the last resort, as before.
        assert_eq!(
            event_notification_in(&completed, NotificationContext::default())
                .unwrap()
                .title,
            "Thread 9"
        );
    }

    #[test]
    fn converts_ecdsa_der_signature_to_jwt_raw_shape() {
        let der = [
            0x30, 0x44, 0x02, 0x20, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
            1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0x02, 0x20, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
            2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
        ];
        let raw = ecdsa_der_to_raw(&der).unwrap();
        assert_eq!(&raw[..32], &[1; 32]);
        assert_eq!(&raw[32..], &[2; 32]);
    }

    #[test]
    fn apns_curl_config_escape_keeps_values_single_line() {
        assert_eq!(curl_config_escape("a\"b\\c\n"), "a\\\"b\\\\c\\n");
    }

    #[test]
    #[ignore]
    fn live_apns_smoke_reaches_apns() {
        let Some(config) = ApnsConfig::from_env() else {
            panic!("APNs env is required for this smoke test");
        };
        let (_temp, db_path) = migrated_db();
        let token =
            std::env::var("ARCHDUCTOR_APNS_TEST_DEVICE_TOKEN").unwrap_or_else(|_| "0".repeat(64));
        NotificationDeviceStore::new(&db_path)
            .register("ios", &token, &config.topic)
            .unwrap();

        let notification = EventNotification {
            id: "apns-live-smoke".to_owned(),
            title: "Archductor smoke".to_owned(),
            body: "APNs smoke test".to_owned(),
            thread_id: None,
        };
        let result = send_apns_notification(&db_path, &config, &notification);
        if std::env::var("ARCHDUCTOR_APNS_TEST_DEVICE_TOKEN").is_ok() {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap(), 0);
        }
    }
}
