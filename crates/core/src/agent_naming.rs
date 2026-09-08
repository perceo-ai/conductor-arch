//! Ask a provider for a workspace/branch/chat name in one dedicated call.
//!
//! Naming used to ride along inside the coding turn: a hidden block appended to
//! the user's message asked the agent to emit `<archductor_metadata>`. That is
//! best-effort by construction — the agent answers it or it does not — so a chat
//! either got a real name or kept Archductor's "first few words of the request"
//! fallback, and which one you got was not predictable.
//!
//! This runs the naming as its own non-interactive invocation of the same
//! provider the chat uses, whose entire job is to return the names. It does not
//! depend on the agent cooperating mid-turn, and it runs on every new chat, so
//! the outcome is the same every time.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use tracing::warn;

/// How long a naming call may take before it is abandoned. Naming is a
/// side-quest; it must never hold up a turn or leak a process.
pub const NAMING_CALL_TIMEOUT: Duration = Duration::from_secs(90);

/// Names a provider returned for a new chat.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentNames {
    pub workspace_name: Option<String>,
    pub branch_name: Option<String>,
    pub chat_title: Option<String>,
}

impl AgentNames {
    pub fn is_empty(&self) -> bool {
        self.workspace_name.is_none() && self.branch_name.is_none() && self.chat_title.is_none()
    }
}

/// What a single naming call should produce.
#[derive(Debug, Clone)]
pub struct NamingCall<'a> {
    /// Provider key of the chat being named (`claude`, `codex`).
    pub provider_key: &'a str,
    /// Executable to run. Normally the provider's default command.
    pub command: &'a str,
    /// Directory to run in — the workspace checkout.
    pub cwd: &'a Path,
    /// The user's request, verbatim.
    pub request: &'a str,
    pub wants_workspace_name: bool,
    pub wants_branch_name: bool,
}

/// The prompt sent to the provider.
///
/// Deliberately narrow: it asks for JSON and nothing else, states the rules the
/// existing metadata block used so names stay consistent with what the agent
/// path produced, and never mentions tools or the repository, because the model
/// only needs the request text to name the work.
pub fn naming_prompt(call: &NamingCall<'_>) -> String {
    let mut fields = Vec::new();
    let mut rules = Vec::new();
    if call.wants_workspace_name {
        fields.push("\"workspace_name\":\"…\"");
        rules.push("- workspace_name: 2-4 words naming the task, lowercase, spaces allowed");
    }
    if call.wants_branch_name {
        fields.push("\"branch_name\":\"…\"");
        rules.push("- branch_name: kebab-case slug of the same task, no prefix");
    }
    fields.push("\"chat_title\":\"…\"");
    rules.push("- chat_title: at most 48 characters, title case");

    format!(
        "Name a coding task from the request below. Answer with one JSON object \
         and no other text, no explanation, and no code fence.\n\n\
         {{{fields}}}\n\n\
         {rules}\n\n\
         Do not answer the request, do not read any files, and do not use tools. \
         Name it only.\n\n\
         Request:\n{request}",
        fields = fields.join(","),
        rules = rules.join("\n"),
        request = call.request.trim(),
    )
}

/// Run the naming call and parse what came back.
pub fn request_names(call: &NamingCall<'_>) -> Result<AgentNames> {
    let prompt = naming_prompt(call);
    let text = match call.provider_key {
        "claude" => run_claude(call, &prompt)?,
        "codex" => run_codex(call, &prompt)?,
        other => return Err(anyhow!("no naming invocation is defined for {other}")),
    };
    parse_names(&text)
        .ok_or_else(|| anyhow!("naming call returned no usable JSON object: {text:.400}"))
}

/// `claude -p` prints one JSON envelope; the model's text is in `result`.
///
/// A small model is requested explicitly: naming is a trivial task and the
/// default is whatever the user's session model is, which for a one-line answer
/// is an absurd amount of money per chat.
fn run_claude(call: &NamingCall<'_>, prompt: &str) -> Result<String> {
    let output = run_with_timeout(
        Command::new(call.command)
            .args(["-p", "--output-format", "json", "--model", "haiku"])
            .arg(prompt)
            .current_dir(call.cwd),
    )?;
    let envelope: Value =
        serde_json::from_slice(&output).context("parse claude naming response envelope")?;
    envelope
        .get("result")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("claude naming response had no result field"))
}

/// `codex exec` writes its final message to the file given to `-o`, which keeps
/// the answer clean of the progress it prints on stdout.
fn run_codex(call: &NamingCall<'_>, prompt: &str) -> Result<String> {
    let answer_path =
        std::env::temp_dir().join(format!("archductor-naming-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<String> {
        run_with_timeout(
            Command::new(call.command)
                .arg("exec")
                .arg("--skip-git-repo-check")
                .arg("-o")
                .arg(&answer_path)
                .arg(prompt)
                .current_dir(call.cwd),
        )?;
        std::fs::read_to_string(&answer_path).context("read codex naming answer")
    })();
    let _ = std::fs::remove_file(&answer_path);
    result
}

/// Spawn, wait with a cap, and never leave the child behind.
fn run_with_timeout(command: &mut Command) -> Result<Vec<u8>> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("spawn naming call")?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().context("collect naming output")?;
                anyhow::ensure!(status.success(), "naming call exited with {status}");
                return Ok(output.stdout);
            }
            Ok(None) if started.elapsed() >= NAMING_CALL_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(anyhow!("naming call timed out"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err).context("wait on naming call");
            }
        }
    }
}

/// Pull the names out of whatever the model actually said.
///
/// Models answer this prompt with a bare object, a ```json fence, or the object
/// with a sentence in front of it, and being strict about it would put the whole
/// feature back to being unreliable — which is the thing it exists to fix.
pub fn parse_names(text: &str) -> Option<AgentNames> {
    let value: Value = serde_json::from_str(&first_json_object(text)?).ok()?;
    let field = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|found| !found.is_empty())
            .map(str::to_owned)
    };
    let names = AgentNames {
        workspace_name: field("workspace_name"),
        branch_name: field("branch_name"),
        chat_title: field("chat_title"),
    };
    (!names.is_empty()).then_some(names)
}

/// The first balanced `{…}` run in the text, ignoring braces inside strings.
fn first_json_object(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth = 0_usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in bytes.iter().enumerate().skip(start) {
        if in_string {
            match byte {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start..=offset].to_owned());
                }
            }
            _ => {}
        }
    }
    None
}

/// Log a naming failure without letting it reach the user: a chat that could not
/// be named keeps Archductor's fallback, which is a cosmetic loss, not an error
/// worth interrupting anyone over.
pub fn warn_naming_failed(thread_id: i64, err: &anyhow::Error) {
    warn!(thread_id, error = %format!("{err:#}"), "deterministic chat naming failed");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call<'a>(request: &'a str) -> NamingCall<'a> {
        NamingCall {
            provider_key: "claude",
            command: "claude",
            cwd: Path::new("/tmp"),
            request,
            wants_workspace_name: true,
            wants_branch_name: true,
        }
    }

    #[test]
    fn prompt_asks_for_every_requested_field() {
        let prompt = naming_prompt(&call("Fix the billing webhook retries"));
        assert!(prompt.contains("\"workspace_name\""));
        assert!(prompt.contains("\"branch_name\""));
        assert!(prompt.contains("\"chat_title\""));
        assert!(prompt.contains("Fix the billing webhook retries"));
        // The naming model must not go off and do the work.
        assert!(prompt.contains("Do not answer the request"));
    }

    #[test]
    fn prompt_omits_fields_that_are_already_settled() {
        let mut only_title = call("Fix billing");
        only_title.wants_workspace_name = false;
        only_title.wants_branch_name = false;
        let prompt = naming_prompt(&only_title);
        assert!(prompt.contains("\"chat_title\""));
        assert!(!prompt.contains("\"workspace_name\""));
        assert!(!prompt.contains("\"branch_name\""));
    }

    #[test]
    fn parses_a_bare_object() {
        let names = parse_names(r#"{"workspace_name":"billing webhook fix","branch_name":"billing-webhook-fix","chat_title":"Billing Webhook Fix"}"#).unwrap();
        assert_eq!(names.workspace_name.as_deref(), Some("billing webhook fix"));
        assert_eq!(names.branch_name.as_deref(), Some("billing-webhook-fix"));
        assert_eq!(names.chat_title.as_deref(), Some("Billing Webhook Fix"));
    }

    #[test]
    fn parses_a_fenced_object() {
        // What `claude -p --model haiku` actually returns for this prompt.
        let names = parse_names("```json\n{\"chat_title\":\"Billing Webhook Fix\"}\n```").unwrap();
        assert_eq!(names.chat_title.as_deref(), Some("Billing Webhook Fix"));
    }

    #[test]
    fn parses_an_object_behind_a_preamble() {
        let names =
            parse_names("Sure! Here are the names:\n{\"chat_title\":\"Retry Backoff\"}").unwrap();
        assert_eq!(names.chat_title.as_deref(), Some("Retry Backoff"));
    }

    #[test]
    fn ignores_braces_inside_strings() {
        let names = parse_names(r#"{"chat_title":"Fix {weird} Braces"}"#).unwrap();
        assert_eq!(names.chat_title.as_deref(), Some("Fix {weird} Braces"));
    }

    #[test]
    fn blank_and_missing_fields_are_dropped() {
        let names = parse_names(r#"{"workspace_name":"  ","chat_title":"Real Title"}"#).unwrap();
        assert_eq!(names.workspace_name, None);
        assert_eq!(names.chat_title.as_deref(), Some("Real Title"));
    }

    #[test]
    fn text_without_an_object_is_not_a_name() {
        assert!(parse_names("I could not name this.").is_none());
        assert!(parse_names("{\"unrelated\":\"value\"}").is_none());
        // An unbalanced object is a truncated answer, not a name.
        assert!(parse_names("{\"chat_title\":\"Half").is_none());
    }

    #[test]
    fn an_unknown_provider_is_an_error_rather_than_a_silent_skip() {
        let mut unknown = call("Fix billing");
        unknown.provider_key = "gemini";
        let err = request_names(&unknown).unwrap_err();
        assert!(err.to_string().contains("gemini"), "{err}");
    }
}
