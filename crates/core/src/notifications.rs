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
        let conn = Connection::open(&self.db_path)?;
        crate::storage::migrate_workspace_db(&conn)?;
        Ok(conn)
    }
}

pub fn event_notification(event: &ArchcarEvent) -> Option<EventNotification> {
    match event {
        ArchcarEvent::ProviderInteractionRequested { interaction } => {
            Some(interaction_notification(interaction))
        }
        ArchcarEvent::TurnCompleted {
            session_id,
            thread_id,
            status,
        } => {
            let final_status = status.as_deref().unwrap_or("completed").trim();
            let final_status = if final_status.is_empty() {
                "completed"
            } else {
                final_status
            };
            Some(EventNotification {
                id: format!("turn-{session_id}-{thread_id}-{final_status}"),
                title: if final_status == "completed" {
                    "Chat finished".to_owned()
                } else {
                    "Chat stopped".to_owned()
                },
                body: format!("Thread {thread_id} {final_status}."),
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
            title: "Chat failed".to_owned(),
            body: message.clone(),
            thread_id: *thread_id,
        }),
        ArchcarEvent::BackgroundTaskUpdated { task } => background_task_notification(task),
        _ => None,
    }
}

pub fn notify_event(db_path: PathBuf, event: ArchcarEvent) {
    let Some(notification) = event_notification(&event) else {
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

pub fn send_apns_notification(
    db_path: &Path,
    config: &ApnsConfig,
    notification: &EventNotification,
) -> Result<usize> {
    let devices = NotificationDeviceStore::new(db_path).list()?;
    let jwt = apns_jwt(config)?;
    let payload = notification_payload(notification);
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
        let endpoint = match std::env::var("ARCHDUCTOR_APNS_ENDPOINT").ok() {
            Some(endpoint) => endpoint,
            None => match std::env::var("ARCHDUCTOR_APNS_ENV").as_deref() {
                Ok("production") => "https://api.push.apple.com".to_owned(),
                _ => "https://api.sandbox.push.apple.com".to_owned(),
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

fn interaction_notification(interaction: &ProviderInteractionRecord) -> EventNotification {
    EventNotification {
        id: format!("interaction-{}", interaction.id),
        title: "Input required".to_owned(),
        body: joined_body(&interaction.title, &interaction.detail),
        thread_id: Some(interaction.thread_id),
    }
}

fn background_task_notification(task: &BackgroundTask) -> Option<EventNotification> {
    if task.status != "ready" && task.status != "failed" {
        return None;
    }
    Some(EventNotification {
        id: format!("background-task-{}-{}", task.id, task.status),
        title: if task.status == "ready" {
            "Background task ready".to_owned()
        } else {
            "Background task failed".to_owned()
        },
        body: format!(
            "#{} {}{}: {}",
            task.id,
            task.title,
            task.workspace_name
                .as_deref()
                .map(|name| format!(" ({name})"))
                .unwrap_or_default(),
            if task.detail.is_empty() {
                task.error.as_deref().unwrap_or(&task.status)
            } else {
                &task.detail
            }
        ),
        thread_id: None,
    })
}

fn notification_payload(notification: &EventNotification) -> String {
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

fn joined_body(title: &str, detail: &str) -> String {
    let title = title.trim();
    let detail = detail.trim();
    match (title.is_empty(), detail.is_empty()) {
        (true, true) => String::new(),
        (false, true) => title.to_owned(),
        (true, false) => detail.to_owned(),
        (false, false) => format!("{title} - {detail}"),
    }
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
                title: "Input required".to_owned(),
                body: "Approve command? - cargo test".to_owned(),
                thread_id: Some(9),
            })
        );
        assert_eq!(
            event_notification(&ArchcarEvent::TurnCompleted {
                session_id: 11,
                thread_id: 9,
                status: Some("completed".to_owned()),
            })
            .unwrap()
            .title,
            "Chat finished"
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
