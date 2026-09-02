use std::path::Path;

use serde_json::{json, Map, Value};

use crate::archcar::harness_contract::{InteractionAnswer, ProviderInteractionResolution};

const ARCHCAR_CLAUDE_HOOK_FLAG: &str = "--archcar-claude-hook";

/// The binary that implements `--archcar-claude-hook`.
///
/// It is the CLI, not the daemon. That distinction only shows up in a real
/// deployment: a dev sidecar runs as `archductor --archcar-serve`, so
/// `current_exe()` is already the right binary, but a service install runs
/// `archcar` — which ignores the flag, tries to bind the socket a daemon is
/// already holding, and fails. Every hook then errors: permission prompts,
/// plan mode, and the SessionStart context injection.
const HOOK_BINARY_STEM: &str = "archductor";

/// Resolve the hook command from the running executable: use it when it is
/// already the CLI, else the CLI beside it, else leave the bare name for PATH.
pub fn resolve_claude_hook_binary(current_exe: &Path) -> std::path::PathBuf {
    let file_name = format!(
        "{HOOK_BINARY_STEM}{}",
        if cfg!(windows) { ".exe" } else { "" }
    );
    if current_exe.file_stem().and_then(|stem| stem.to_str()) == Some(HOOK_BINARY_STEM) {
        return current_exe.to_path_buf();
    }
    let sibling = current_exe.with_file_name(&file_name);
    if sibling.exists() {
        return sibling;
    }
    std::path::PathBuf::from(file_name)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeHookRequest {
    PreToolUse {
        event_name: String,
    },
    PermissionRequest,
    AskUserQuestion,
    ExitPlanMode,
    /// Fires after each tool call. Archductor uses it to remind a session that
    /// its workspace summary has gone stale, without interrupting the turn.
    PostToolUse,
    /// Fires as the session starts, before any request. Carries Archductor's
    /// standing contract and the summary the last session left behind.
    SessionStart,
    Unknown {
        event_name: String,
    },
}

impl ClaudeHookRequest {
    pub fn event_name(&self) -> &str {
        match self {
            Self::PreToolUse { event_name } => event_name,
            Self::PermissionRequest => "PermissionRequest",
            Self::AskUserQuestion => "AskUserQuestion",
            Self::ExitPlanMode => "ExitPlanMode",
            Self::PostToolUse => "PostToolUse",
            Self::SessionStart => "SessionStart",
            Self::Unknown { event_name } => event_name,
        }
    }

    /// True for the events Archductor answers with context rather than a
    /// permission decision.
    pub fn is_context_event(&self) -> bool {
        matches!(self, Self::PostToolUse | Self::SessionStart)
    }
}

/// The hook reply that hands text to the model without deciding anything.
pub fn encode_claude_hook_context(event_name: &str, context: &str) -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": event_name,
            "additionalContext": context,
        }
    })
}

/// A reply that says nothing, for a context event with nothing to add.
pub fn encode_claude_hook_noop() -> Value {
    json!({})
}

pub fn build_claude_hook_settings(executable: &Path, thread_id: i64) -> Value {
    let hook_binary = resolve_claude_hook_binary(executable);
    let hook = json!({
        "type": "command",
        "command": hook_binary.to_string_lossy(),
        "args": [ARCHCAR_CLAUDE_HOOK_FLAG, thread_id.to_string()],
    });
    json!({
        "hooks": {
            "PreToolUse": [{
                "matcher": ".*",
                "hooks": [hook.clone()]
            }],
            "PermissionRequest": [{
                "matcher": ".*",
                "hooks": [hook.clone()]
            }],
            "AskUserQuestion": [{
                "matcher": "AskUserQuestion|ExitPlanMode",
                "hooks": [hook.clone()]
            }],
            "ExitPlanMode": [{
                "matcher": "AskUserQuestion|ExitPlanMode",
                "hooks": [hook.clone()]
            }],
            // Context maintenance, not permissions: these two let Archductor
            // hand the session its workspace summary at the start and remind it
            // when the summary has gone stale mid-run.
            "SessionStart": [{
                "matcher": ".*",
                "hooks": [hook.clone()]
            }],
            "PostToolUse": [{
                "matcher": ".*",
                "hooks": [hook]
            }]
        }
    })
}

pub fn classify_claude_hook_request(input: &Value) -> ClaudeHookRequest {
    let event_name = input
        .get("hook_event_name")
        .or_else(|| input.get("hookEventName"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tool_name = input
        .get("tool_name")
        .or_else(|| input.get("toolName"))
        .and_then(Value::as_str);

    match event_name {
        "PermissionRequest" => ClaudeHookRequest::PermissionRequest,
        "AskUserQuestion" => ClaudeHookRequest::AskUserQuestion,
        "ExitPlanMode" => ClaudeHookRequest::ExitPlanMode,
        "PostToolUse" => ClaudeHookRequest::PostToolUse,
        "SessionStart" => ClaudeHookRequest::SessionStart,
        "PreToolUse" if tool_name == Some("AskUserQuestion") => ClaudeHookRequest::AskUserQuestion,
        "PreToolUse" if tool_name == Some("ExitPlanMode") => ClaudeHookRequest::ExitPlanMode,
        "PreToolUse" => ClaudeHookRequest::PreToolUse {
            event_name: "PreToolUse".to_owned(),
        },
        "" => ClaudeHookRequest::Unknown {
            event_name: "Unknown".to_owned(),
        },
        other => ClaudeHookRequest::Unknown {
            event_name: other.to_owned(),
        },
    }
}

pub fn encode_claude_hook_defer(request: &ClaudeHookRequest) -> Value {
    let hook_event_name = match request {
        ClaudeHookRequest::PermissionRequest => "PermissionRequest",
        ClaudeHookRequest::AskUserQuestion | ClaudeHookRequest::ExitPlanMode => "PreToolUse",
        other => other.event_name(),
    };
    json!({
        "hookSpecificOutput": {
            "hookEventName": hook_event_name,
            "permissionDecision": "defer"
        }
    })
}

pub fn encode_claude_hook_resolution(
    request: &Value,
    resolution: &ProviderInteractionResolution,
) -> Value {
    match (classify_claude_hook_request(request), resolution) {
        (ClaudeHookRequest::PermissionRequest, ProviderInteractionResolution::Approve) => {
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "allow",
                        "updatedPermissions": permission_suggestions(request)
                    }
                }
            })
        }
        (ClaudeHookRequest::PermissionRequest, ProviderInteractionResolution::Deny { reason }) => {
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "deny",
                        "message": reason.clone().unwrap_or_else(|| "Denied by Archductor.".to_owned())
                    }
                }
            })
        }
        (ClaudeHookRequest::AskUserQuestion, ProviderInteractionResolution::Answer { answers }) => {
            encode_updated_input("AskUserQuestion", request, answers_object(answers))
        }
        (ClaudeHookRequest::ExitPlanMode, ProviderInteractionResolution::Approve) => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow"
            }
        }),
        (ClaudeHookRequest::ExitPlanMode, ProviderInteractionResolution::Deny { reason }) => {
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason.clone().unwrap_or_else(|| "Keep planning.".to_owned())
                }
            })
        }
        (_, ProviderInteractionResolution::Deny { reason }) => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason.clone().unwrap_or_else(|| "Denied by Archductor.".to_owned())
            }
        }),
        _ => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow"
            }
        }),
    }
}

pub fn handle_claude_hook_json(_thread_id: i64, stdin: &str) -> Value {
    let request = serde_json::from_str::<Value>(stdin).unwrap_or(Value::Null);
    encode_claude_hook_defer(&classify_claude_hook_request(&request))
}

fn encode_updated_input(event_name: &str, request: &Value, answers: Value) -> Value {
    let mut updated_input = request
        .get("tool_input")
        .or_else(|| request.get("toolInput"))
        .cloned()
        .unwrap_or_else(|| request.clone());
    if let Value::Object(ref mut object) = updated_input {
        object.insert("answers".to_owned(), answers);
    }
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "updatedInput": updated_input,
            "toolName": event_name
        }
    })
}

fn permission_suggestions(request: &Value) -> Value {
    request
        .get("permission_suggestions")
        .or_else(|| request.get("permissionSuggestions"))
        .cloned()
        .unwrap_or_else(|| json!([]))
}

fn answers_object(answers: &[InteractionAnswer]) -> Value {
    let mut object = Map::new();
    for answer in answers {
        object.insert(
            answer.question_id.clone(),
            Value::String(answer.values.join(", ")),
        );
    }
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn claude_hooks_permission_request_defers_pretooluse() {
        let input = json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "cargo test"}
        });

        assert_eq!(
            encode_claude_hook_defer(&classify_claude_hook_request(&input)),
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "defer"
                }
            })
        );
    }

    #[test]
    fn claude_hooks_permission_resolution_allows_with_updated_permissions() {
        let suggestions = json!([{"tool": "Bash", "rule": "cargo test"}]);
        let input = json!({
            "hook_event_name": "PermissionRequest",
            "permission_suggestions": suggestions
        });

        assert_eq!(
            encode_claude_hook_resolution(&input, &ProviderInteractionResolution::Approve),
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "allow",
                        "updatedPermissions": suggestions
                    }
                }
            })
        );
    }

    #[test]
    fn claude_hooks_question_resolution_echoes_questions_and_answers() {
        let input = json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "AskUserQuestion",
            "tool_input": {
                "questions": [{"id": "scope", "question": "Ship it?"}]
            }
        });

        assert_eq!(
            encode_claude_hook_resolution(
                &input,
                &ProviderInteractionResolution::Answer {
                    answers: vec![InteractionAnswer {
                        question_id: "scope".to_owned(),
                        values: vec!["yes".to_owned()],
                    }]
                }
            ),
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "updatedInput": {
                        "questions": [{"id": "scope", "question": "Ship it?"}],
                        "answers": {"scope": "yes"}
                    },
                    "toolName": "AskUserQuestion"
                }
            })
        );
    }

    #[test]
    fn claude_hooks_plan_resolution_approves_and_denies() {
        let input = json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "ExitPlanMode",
            "tool_input": {"plan": "Do work"}
        });

        assert_eq!(
            encode_claude_hook_resolution(&input, &ProviderInteractionResolution::Approve),
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow"
                }
            })
        );
        assert_eq!(
            encode_claude_hook_resolution(
                &input,
                &ProviderInteractionResolution::Deny {
                    reason: Some("Keep planning".to_owned())
                }
            ),
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "Keep planning"
                }
            })
        );
    }

    #[test]
    fn claude_hook_settings_register_the_context_events() {
        let settings = build_claude_hook_settings(Path::new("/usr/local/bin/archductor"), 7);

        for event in ["SessionStart", "PostToolUse"] {
            let hook = &settings["hooks"][event][0]["hooks"][0];
            assert_eq!(hook["command"], "/usr/local/bin/archductor", "{event}");
            assert_eq!(hook["args"][1], "7", "{event}");
        }
    }

    #[test]
    fn hooks_point_at_the_cli_even_when_the_daemon_binary_builds_them() {
        // A service install runs `archcar`, which does not implement
        // `--archcar-claude-hook`: it would try to bind the socket the daemon
        // already holds and every hook would fail. Only a dev sidecar happens
        // to be the right binary already.
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path();
        let archcar = bin.join("archcar");
        let archductor = bin.join(if cfg!(windows) {
            "archductor.exe"
        } else {
            "archductor"
        });
        std::fs::write(&archcar, "").unwrap();
        std::fs::write(&archductor, "").unwrap();

        let settings = build_claude_hook_settings(&archcar, 3);
        assert_eq!(
            settings["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            archductor.to_string_lossy().as_ref()
        );

        // The dev sidecar path is unchanged.
        let settings = build_claude_hook_settings(&archductor, 3);
        assert_eq!(
            settings["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            archductor.to_string_lossy().as_ref()
        );
    }

    #[test]
    fn the_hook_binary_falls_back_to_the_bare_name_for_path_lookup() {
        // Nothing beside the daemon: leave a bare name so PATH resolves it,
        // rather than a path that is known not to work.
        let temp = tempfile::tempdir().unwrap();
        let lonely = temp.path().join("archcar");
        std::fs::write(&lonely, "").unwrap();

        let resolved = resolve_claude_hook_binary(&lonely);
        assert_eq!(
            resolved,
            Path::new(if cfg!(windows) {
                "archductor.exe"
            } else {
                "archductor"
            })
        );
    }

    #[test]
    fn context_events_are_classified_apart_from_permission_events() {
        let session_start = classify_claude_hook_request(&json!({
            "hook_event_name": "SessionStart"
        }));
        let post_tool = classify_claude_hook_request(&json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash"
        }));
        let permission = classify_claude_hook_request(&json!({
            "hook_event_name": "PermissionRequest"
        }));

        assert!(session_start.is_context_event());
        assert!(post_tool.is_context_event());
        assert!(!permission.is_context_event());
        assert_eq!(
            encode_claude_hook_context("PostToolUse", "update your summary")["hookSpecificOutput"]
                ["additionalContext"],
            "update your summary"
        );
    }

    #[test]
    fn claude_hook_settings_builds_exec_form_hooks() {
        let executable = PathBuf::from("/usr/local/bin/archductor");
        let thread_id = 42;
        let settings = build_claude_hook_settings(&executable, thread_id);
        let permission_hook = &settings["hooks"]["PermissionRequest"][0];
        let question_hook = &settings["hooks"]["AskUserQuestion"][0];
        let hook = &permission_hook["hooks"][0];

        assert_eq!(permission_hook["matcher"], ".*");
        assert_eq!(question_hook["matcher"], "AskUserQuestion|ExitPlanMode");
        assert_eq!(hook["command"], executable.to_string_lossy().as_ref());
        assert!(hook["args"]
            .as_array()
            .unwrap()
            .contains(&json!(thread_id.to_string())));
        assert!(settings.get("disableAllHooks").is_none());
    }
}
