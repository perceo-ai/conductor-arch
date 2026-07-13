use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use archductor_core::redaction::redact_sensitive_text;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ProviderProjectionCategory {
    UserMessage,
    AssistantMessage,
    Plan,
    Reasoning,
    Command,
    Process,
    FileRead,
    FileWrite,
    FilePatch,
    FileDiff,
    McpTool,
    NativeTool,
    Skill,
    Plugin,
    Hook,
    Subagent,
    NestedTranscript,
    BackgroundTerminal,
    BackgroundTask,
    Approval,
    Question,
    Web,
    Image,
    Usage,
    Cost,
    Context,
    RateLimit,
    Error,
    Status,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ProviderProjectionStatus {
    Pending,
    Running,
    Complete,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ProviderProjectionStreamState {
    Snapshot,
    Streaming,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ProjectionRenderClass {
    UserChat,
    AssistantChat,
    PlanCard,
    ReasoningCard,
    CommandCard,
    ProcessCard,
    FileCard,
    DiffCard,
    ToolCard,
    SkillCard,
    PluginCard,
    HookCard,
    SubagentCard,
    NestedTranscriptCard,
    BackgroundCard,
    PromptCard,
    WebCard,
    ImageCard,
    UsageCard,
    WarningCard,
    ErrorCard,
    StatusCard,
    FallbackCard,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProviderProjectionEvent {
    pub canonical_id: String,
    pub sequence: u64,
    pub category: ProviderProjectionCategory,
    pub title: String,
    pub body: String,
    pub status: ProviderProjectionStatus,
    pub stream_state: ProviderProjectionStreamState,
    pub parent_id: Option<String>,
    pub nested_thread_id: Option<String>,
    pub raw_payload: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderProjectionItem {
    pub id: String,
    pub sequence: u64,
    pub category: ProviderProjectionCategory,
    pub render_class: ProjectionRenderClass,
    pub title: String,
    pub body: String,
    pub status: ProviderProjectionStatus,
    pub stream_state: ProviderProjectionStreamState,
    pub parent_id: Option<String>,
    pub nested_thread_id: Option<String>,
    pub raw_payload: Option<String>,
    pub inspectable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderProjection {
    pub items: Vec<ProviderProjectionItem>,
    pub signature: ProviderProjectionSignature,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderProjectionSignature {
    pub item_ids: Vec<String>,
    pub items: Vec<ProviderProjectionItemSignature>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderProjectionItemSignature {
    pub id: String,
    pub category: ProviderProjectionCategory,
    pub render_class: ProjectionRenderClass,
    pub status: ProviderProjectionStatus,
    pub stream_state: ProviderProjectionStreamState,
    pub parent_id: Option<String>,
    pub nested_thread_id: Option<String>,
    pub content_hash: u64,
}

pub(crate) fn render_provider_event_projection(
    events: Vec<ProviderProjectionEvent>,
) -> ProviderProjection {
    let mut items = Vec::<ProviderProjectionItem>::new();
    let mut positions = HashMap::<String, usize>::new();

    for event in events {
        let id = canonical_projection_id(&event);
        let item = projection_item_from_event(id.clone(), event);
        if let Some(index) = positions.get(&id).copied() {
            items[index] = ProviderProjectionItem {
                sequence: items[index].sequence,
                ..item
            };
        } else {
            positions.insert(id, items.len());
            items.push(item);
        }
    }

    items.sort_by(|left, right| {
        left.sequence
            .cmp(&right.sequence)
            .then_with(|| left.id.cmp(&right.id))
    });
    let signature = projection_signature(&items);

    ProviderProjection { items, signature }
}

fn canonical_projection_id(event: &ProviderProjectionEvent) -> String {
    let id = event.canonical_id.trim();
    if id.is_empty() {
        format!("missing-canonical-id-{}", event.sequence)
    } else {
        id.to_owned()
    }
}

fn projection_item_from_event(
    id: String,
    event: ProviderProjectionEvent,
) -> ProviderProjectionItem {
    let render_class = render_class_for_category(event.category);
    let title = projection_title(event.category, &event.title);
    let raw_payload = event
        .raw_payload
        .as_ref()
        .map(redacted_payload_display)
        .filter(|payload| !payload.trim().is_empty());
    let inspectable = raw_payload.is_some()
        || matches!(
            render_class,
            ProjectionRenderClass::FallbackCard
                | ProjectionRenderClass::ToolCard
                | ProjectionRenderClass::CommandCard
                | ProjectionRenderClass::FileCard
                | ProjectionRenderClass::DiffCard
                | ProjectionRenderClass::SubagentCard
                | ProjectionRenderClass::NestedTranscriptCard
        );

    ProviderProjectionItem {
        id,
        sequence: event.sequence,
        category: event.category,
        render_class,
        title,
        body: event.body,
        status: event.status,
        stream_state: event.stream_state,
        parent_id: event.parent_id,
        nested_thread_id: event.nested_thread_id,
        raw_payload,
        inspectable,
    }
}

fn render_class_for_category(category: ProviderProjectionCategory) -> ProjectionRenderClass {
    match category {
        ProviderProjectionCategory::UserMessage => ProjectionRenderClass::UserChat,
        ProviderProjectionCategory::AssistantMessage => ProjectionRenderClass::AssistantChat,
        ProviderProjectionCategory::Plan => ProjectionRenderClass::PlanCard,
        ProviderProjectionCategory::Reasoning => ProjectionRenderClass::ReasoningCard,
        ProviderProjectionCategory::Command => ProjectionRenderClass::CommandCard,
        ProviderProjectionCategory::Process => ProjectionRenderClass::ProcessCard,
        ProviderProjectionCategory::FileRead
        | ProviderProjectionCategory::FileWrite
        | ProviderProjectionCategory::FilePatch => ProjectionRenderClass::FileCard,
        ProviderProjectionCategory::FileDiff => ProjectionRenderClass::DiffCard,
        ProviderProjectionCategory::McpTool | ProviderProjectionCategory::NativeTool => {
            ProjectionRenderClass::ToolCard
        }
        ProviderProjectionCategory::Skill => ProjectionRenderClass::SkillCard,
        ProviderProjectionCategory::Plugin => ProjectionRenderClass::PluginCard,
        ProviderProjectionCategory::Hook => ProjectionRenderClass::HookCard,
        ProviderProjectionCategory::Subagent => ProjectionRenderClass::SubagentCard,
        ProviderProjectionCategory::NestedTranscript => ProjectionRenderClass::NestedTranscriptCard,
        ProviderProjectionCategory::BackgroundTerminal
        | ProviderProjectionCategory::BackgroundTask => ProjectionRenderClass::BackgroundCard,
        ProviderProjectionCategory::Approval | ProviderProjectionCategory::Question => {
            ProjectionRenderClass::PromptCard
        }
        ProviderProjectionCategory::Web => ProjectionRenderClass::WebCard,
        ProviderProjectionCategory::Image => ProjectionRenderClass::ImageCard,
        ProviderProjectionCategory::Usage
        | ProviderProjectionCategory::Cost
        | ProviderProjectionCategory::Context => ProjectionRenderClass::UsageCard,
        ProviderProjectionCategory::RateLimit => ProjectionRenderClass::WarningCard,
        ProviderProjectionCategory::Error => ProjectionRenderClass::ErrorCard,
        ProviderProjectionCategory::Status => ProjectionRenderClass::StatusCard,
        ProviderProjectionCategory::Unknown => ProjectionRenderClass::FallbackCard,
    }
}

fn projection_title(category: ProviderProjectionCategory, title: &str) -> String {
    let title = title.trim();
    if !title.is_empty() {
        return title.to_owned();
    }

    match category {
        ProviderProjectionCategory::UserMessage => "User".to_owned(),
        ProviderProjectionCategory::AssistantMessage => "Assistant".to_owned(),
        ProviderProjectionCategory::Plan => "Plan".to_owned(),
        ProviderProjectionCategory::Reasoning => "Reasoning".to_owned(),
        ProviderProjectionCategory::Command => "Command".to_owned(),
        ProviderProjectionCategory::Process => "Process".to_owned(),
        ProviderProjectionCategory::FileRead => "File read".to_owned(),
        ProviderProjectionCategory::FileWrite => "File write".to_owned(),
        ProviderProjectionCategory::FilePatch => "Patch".to_owned(),
        ProviderProjectionCategory::FileDiff => "Diff".to_owned(),
        ProviderProjectionCategory::McpTool => "MCP tool".to_owned(),
        ProviderProjectionCategory::NativeTool => "Native tool".to_owned(),
        ProviderProjectionCategory::Skill => "Skill".to_owned(),
        ProviderProjectionCategory::Plugin => "Plugin".to_owned(),
        ProviderProjectionCategory::Hook => "Hook".to_owned(),
        ProviderProjectionCategory::Subagent => "Subagent".to_owned(),
        ProviderProjectionCategory::NestedTranscript => "Nested transcript".to_owned(),
        ProviderProjectionCategory::BackgroundTerminal => "Background terminal".to_owned(),
        ProviderProjectionCategory::BackgroundTask => "Background task".to_owned(),
        ProviderProjectionCategory::Approval => "Approval".to_owned(),
        ProviderProjectionCategory::Question => "Question".to_owned(),
        ProviderProjectionCategory::Web => "Web".to_owned(),
        ProviderProjectionCategory::Image => "Image".to_owned(),
        ProviderProjectionCategory::Usage => "Usage".to_owned(),
        ProviderProjectionCategory::Cost => "Cost".to_owned(),
        ProviderProjectionCategory::Context => "Context".to_owned(),
        ProviderProjectionCategory::RateLimit => "Rate limit".to_owned(),
        ProviderProjectionCategory::Error => "Error".to_owned(),
        ProviderProjectionCategory::Status => "Status".to_owned(),
        ProviderProjectionCategory::Unknown => "Unknown provider event".to_owned(),
    }
}

fn projection_signature(items: &[ProviderProjectionItem]) -> ProviderProjectionSignature {
    ProviderProjectionSignature {
        item_ids: items.iter().map(|item| item.id.clone()).collect(),
        items: items
            .iter()
            .map(|item| ProviderProjectionItemSignature {
                id: item.id.clone(),
                category: item.category,
                render_class: item.render_class,
                status: item.status,
                stream_state: item.stream_state,
                parent_id: item.parent_id.clone(),
                nested_thread_id: item.nested_thread_id.clone(),
                content_hash: projection_item_content_hash(item),
            })
            .collect(),
    }
}

fn projection_item_content_hash(item: &ProviderProjectionItem) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    item.title.hash(&mut hasher);
    item.body.hash(&mut hasher);
    item.raw_payload.hash(&mut hasher);
    hasher.finish()
}

fn redacted_payload_display(payload: &Value) -> String {
    serde_json::to_string_pretty(&redact_json_value(payload)).unwrap_or_default()
}

fn redact_json_value(value: &Value) -> Value {
    match value {
        Value::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, value)| {
                    let redacted = if secret_like_key(key) {
                        Value::String("[redacted]".to_owned())
                    } else {
                        redact_json_value(value)
                    };
                    (key.clone(), redacted)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(redact_json_value).collect()),
        Value::String(value) => Value::String(redact_sensitive_text(value)),
        other => other.clone(),
    }
}

fn secret_like_key(key: &str) -> bool {
    let key = key.trim().to_ascii_lowercase();
    key.contains("token")
        || key.contains("secret")
        || key.contains("password")
        || key.contains("api_key")
        || key.contains("apikey")
        || key.contains("access_key")
        || key.contains("private_key")
        || key.contains("credential")
        || key == "auth"
        || key.ends_with("_auth")
        || matches!(
            key.as_str(),
            "authorization"
                | "proxy_authorization"
                | "www_authorization"
                | "authorization_header"
                | "auth_header"
                | "bearer"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(
        id: &str,
        sequence: u64,
        category: ProviderProjectionCategory,
        title: &str,
        body: &str,
    ) -> ProviderProjectionEvent {
        ProviderProjectionEvent {
            canonical_id: id.to_owned(),
            sequence,
            category,
            title: title.to_owned(),
            body: body.to_owned(),
            status: ProviderProjectionStatus::Complete,
            stream_state: ProviderProjectionStreamState::Complete,
            parent_id: None,
            nested_thread_id: None,
            raw_payload: None,
        }
    }

    #[test]
    fn provider_projection_orders_and_dedupes_streaming_updates_by_canonical_id() {
        let mut first = event(
            "assistant-1",
            2,
            ProviderProjectionCategory::AssistantMessage,
            "Assistant",
            "First paragraph",
        );
        first.status = ProviderProjectionStatus::Running;
        first.stream_state = ProviderProjectionStreamState::Streaming;
        let updated = event(
            "assistant-1",
            4,
            ProviderProjectionCategory::AssistantMessage,
            "Assistant",
            "First paragraph\n\nSecond paragraph",
        );
        let command = event(
            "command-1",
            3,
            ProviderProjectionCategory::Command,
            "cargo test",
            "running",
        );
        let user = event(
            "user-1",
            1,
            ProviderProjectionCategory::UserMessage,
            "User",
            "Run the tests",
        );

        let projection = render_provider_event_projection(vec![first, command, user, updated]);

        assert_eq!(
            projection
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["user-1", "assistant-1", "command-1"]
        );
        assert_eq!(
            projection.items[1].body,
            "First paragraph\n\nSecond paragraph"
        );
        assert_eq!(
            projection.items[1].status,
            ProviderProjectionStatus::Complete
        );
        assert_eq!(
            projection.items[1].stream_state,
            ProviderProjectionStreamState::Complete
        );
        assert_eq!(
            projection.signature.item_ids,
            vec!["user-1", "assistant-1", "command-1"]
        );
    }

    #[test]
    fn provider_projection_classifies_all_explicit_categories() {
        let categories = vec![
            (
                ProviderProjectionCategory::UserMessage,
                ProjectionRenderClass::UserChat,
            ),
            (
                ProviderProjectionCategory::AssistantMessage,
                ProjectionRenderClass::AssistantChat,
            ),
            (
                ProviderProjectionCategory::Plan,
                ProjectionRenderClass::PlanCard,
            ),
            (
                ProviderProjectionCategory::Reasoning,
                ProjectionRenderClass::ReasoningCard,
            ),
            (
                ProviderProjectionCategory::Command,
                ProjectionRenderClass::CommandCard,
            ),
            (
                ProviderProjectionCategory::Process,
                ProjectionRenderClass::ProcessCard,
            ),
            (
                ProviderProjectionCategory::FileRead,
                ProjectionRenderClass::FileCard,
            ),
            (
                ProviderProjectionCategory::FileWrite,
                ProjectionRenderClass::FileCard,
            ),
            (
                ProviderProjectionCategory::FilePatch,
                ProjectionRenderClass::FileCard,
            ),
            (
                ProviderProjectionCategory::FileDiff,
                ProjectionRenderClass::DiffCard,
            ),
            (
                ProviderProjectionCategory::McpTool,
                ProjectionRenderClass::ToolCard,
            ),
            (
                ProviderProjectionCategory::NativeTool,
                ProjectionRenderClass::ToolCard,
            ),
            (
                ProviderProjectionCategory::Skill,
                ProjectionRenderClass::SkillCard,
            ),
            (
                ProviderProjectionCategory::Plugin,
                ProjectionRenderClass::PluginCard,
            ),
            (
                ProviderProjectionCategory::Hook,
                ProjectionRenderClass::HookCard,
            ),
            (
                ProviderProjectionCategory::Subagent,
                ProjectionRenderClass::SubagentCard,
            ),
            (
                ProviderProjectionCategory::NestedTranscript,
                ProjectionRenderClass::NestedTranscriptCard,
            ),
            (
                ProviderProjectionCategory::BackgroundTerminal,
                ProjectionRenderClass::BackgroundCard,
            ),
            (
                ProviderProjectionCategory::BackgroundTask,
                ProjectionRenderClass::BackgroundCard,
            ),
            (
                ProviderProjectionCategory::Approval,
                ProjectionRenderClass::PromptCard,
            ),
            (
                ProviderProjectionCategory::Question,
                ProjectionRenderClass::PromptCard,
            ),
            (
                ProviderProjectionCategory::Web,
                ProjectionRenderClass::WebCard,
            ),
            (
                ProviderProjectionCategory::Image,
                ProjectionRenderClass::ImageCard,
            ),
            (
                ProviderProjectionCategory::Usage,
                ProjectionRenderClass::UsageCard,
            ),
            (
                ProviderProjectionCategory::Cost,
                ProjectionRenderClass::UsageCard,
            ),
            (
                ProviderProjectionCategory::Context,
                ProjectionRenderClass::UsageCard,
            ),
            (
                ProviderProjectionCategory::RateLimit,
                ProjectionRenderClass::WarningCard,
            ),
            (
                ProviderProjectionCategory::Error,
                ProjectionRenderClass::ErrorCard,
            ),
            (
                ProviderProjectionCategory::Status,
                ProjectionRenderClass::StatusCard,
            ),
            (
                ProviderProjectionCategory::Unknown,
                ProjectionRenderClass::FallbackCard,
            ),
        ];

        let projection = render_provider_event_projection(
            categories
                .iter()
                .enumerate()
                .map(|(index, (category, _))| {
                    event(
                        &format!("event-{index}"),
                        index as u64,
                        *category,
                        "title",
                        "body",
                    )
                })
                .collect::<Vec<_>>(),
        );

        assert_eq!(projection.items.len(), categories.len());
        for (item, (_, expected)) in projection.items.iter().zip(categories.iter()) {
            assert_eq!(item.render_class, *expected);
        }
    }

    #[test]
    fn operational_projection_items_never_render_as_assistant_chat() {
        let operational = [
            ProviderProjectionCategory::Plan,
            ProviderProjectionCategory::Reasoning,
            ProviderProjectionCategory::Command,
            ProviderProjectionCategory::Process,
            ProviderProjectionCategory::FileRead,
            ProviderProjectionCategory::FileWrite,
            ProviderProjectionCategory::FilePatch,
            ProviderProjectionCategory::FileDiff,
            ProviderProjectionCategory::McpTool,
            ProviderProjectionCategory::NativeTool,
            ProviderProjectionCategory::Skill,
            ProviderProjectionCategory::Plugin,
            ProviderProjectionCategory::Hook,
            ProviderProjectionCategory::Subagent,
            ProviderProjectionCategory::NestedTranscript,
            ProviderProjectionCategory::BackgroundTerminal,
            ProviderProjectionCategory::BackgroundTask,
            ProviderProjectionCategory::Approval,
            ProviderProjectionCategory::Question,
            ProviderProjectionCategory::Web,
            ProviderProjectionCategory::Image,
            ProviderProjectionCategory::Usage,
            ProviderProjectionCategory::Cost,
            ProviderProjectionCategory::Context,
            ProviderProjectionCategory::RateLimit,
            ProviderProjectionCategory::Error,
            ProviderProjectionCategory::Status,
            ProviderProjectionCategory::Unknown,
        ];

        let projection = render_provider_event_projection(
            operational
                .iter()
                .enumerate()
                .map(|(index, category)| {
                    event(
                        &format!("op-{index}"),
                        index as u64,
                        *category,
                        "title",
                        "body",
                    )
                })
                .collect::<Vec<_>>(),
        );

        assert!(projection
            .items
            .iter()
            .all(|item| item.render_class != ProjectionRenderClass::AssistantChat));
    }

    #[test]
    fn tool_command_status_subagent_and_unknown_events_are_not_assistant_chat() {
        let categories = [
            ProviderProjectionCategory::NativeTool,
            ProviderProjectionCategory::McpTool,
            ProviderProjectionCategory::Command,
            ProviderProjectionCategory::Status,
            ProviderProjectionCategory::Subagent,
            ProviderProjectionCategory::Unknown,
        ];

        let projection = render_provider_event_projection(
            categories
                .iter()
                .enumerate()
                .map(|(index, category)| {
                    event(
                        &format!("provider-event-{index}"),
                        index as u64,
                        *category,
                        "provider event",
                        "body",
                    )
                })
                .collect::<Vec<_>>(),
        );

        assert_eq!(projection.items.len(), categories.len());
        for item in projection.items {
            assert_ne!(item.render_class, ProjectionRenderClass::AssistantChat);
        }
    }

    #[test]
    fn unknown_provider_events_render_as_inspectable_redacted_fallback_cards() {
        let mut unknown = event("unknown-1", 1, ProviderProjectionCategory::Unknown, "", "");
        unknown.raw_payload = Some(json!({
            "type": "future_event",
            "api_key": "sk-secret",
            "nested": { "token": "tok-secret", "safe": "visible" }
        }));

        let projection = render_provider_event_projection(vec![unknown]);
        let item = &projection.items[0];

        assert_eq!(item.render_class, ProjectionRenderClass::FallbackCard);
        assert_eq!(item.title, "Unknown provider event");
        assert!(item.inspectable);
        assert!(item.raw_payload.as_ref().unwrap().contains("[redacted]"));
        assert!(!item.raw_payload.as_ref().unwrap().contains("sk-secret"));
        assert!(!item.raw_payload.as_ref().unwrap().contains("tok-secret"));
        assert!(item.raw_payload.as_ref().unwrap().contains("visible"));
    }

    #[test]
    fn raw_payload_redaction_uses_project_rules_for_strings_and_secret_keys() {
        let mut unknown = event("unknown-2", 1, ProviderProjectionCategory::Unknown, "", "");
        unknown.raw_payload = Some(json!({
            "type": "future_event",
            "authorization": "Bearer auth-secret",
            "private_key": "-----BEGIN PRIVATE KEY-----\nprivate-secret\n-----END PRIVATE KEY-----",
            "safe": "TOKEN=embedded-secret bearer bearer-secret client_secret=client-secret refresh_token=refresh-secret",
            "nested": {
                "safe": "visible",
                "client_secret": "nested-client-secret"
            }
        }));

        let projection = render_provider_event_projection(vec![unknown]);
        let payload = projection.items[0].raw_payload.as_deref().unwrap();

        assert!(payload.contains("[redacted]"));
        assert!(payload.contains("visible"));
        assert!(!payload.contains("auth-secret"));
        assert!(!payload.contains("private-secret"));
        assert!(!payload.contains("embedded-secret"));
        assert!(!payload.contains("bearer-secret"));
        assert!(!payload.contains("client-secret"));
        assert!(!payload.contains("refresh-secret"));
        assert!(!payload.contains("nested-client-secret"));
    }

    #[test]
    fn raw_payload_redaction_preserves_authorization_and_bearer_metadata_keys() {
        let mut unknown = event("unknown-3", 1, ProviderProjectionCategory::Unknown, "", "");
        unknown.raw_payload = Some(json!({
            "authorization": "Bearer auth-secret",
            "bearer": "bearer-secret",
            "authorization_url": "https://auth.example/oauth/authorize",
            "bearer_format": "JWT",
            "diagnostics": {
                "authorization_url": "https://nested.example/oauth/authorize",
                "bearer_format": "opaque"
            }
        }));

        let projection = render_provider_event_projection(vec![unknown]);
        let payload = projection.items[0].raw_payload.as_deref().unwrap();

        assert!(!payload.contains("auth-secret"));
        assert!(!payload.contains("bearer-secret"));
        assert!(payload.contains("authorization_url"));
        assert!(payload.contains("https://auth.example/oauth/authorize"));
        assert!(payload.contains("bearer_format"));
        assert!(payload.contains("JWT"));
        assert!(payload.contains("https://nested.example/oauth/authorize"));
        assert!(payload.contains("opaque"));
    }

    #[test]
    fn nested_transcript_items_keep_parent_child_links_without_flattening() {
        let mut subagent = event(
            "subagent-1",
            1,
            ProviderProjectionCategory::Subagent,
            "Review worker",
            "Spawned",
        );
        subagent.nested_thread_id = Some("thread-child".to_owned());
        let mut child = event(
            "nested-1",
            2,
            ProviderProjectionCategory::NestedTranscript,
            "Child transcript",
            "Child output",
        );
        child.parent_id = Some("subagent-1".to_owned());

        let projection = render_provider_event_projection(vec![child, subagent]);

        assert_eq!(projection.items[0].id, "subagent-1");
        assert_eq!(
            projection.items[0].nested_thread_id.as_deref(),
            Some("thread-child")
        );
        assert_eq!(projection.items[1].parent_id.as_deref(), Some("subagent-1"));
        assert_eq!(
            projection.items[1].render_class,
            ProjectionRenderClass::NestedTranscriptCard
        );
    }
}
