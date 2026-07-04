use linux_archductor_core::codex_tui::{
    CodexParseBenchmark, CodexParsedItem, CodexTranscriptEvent, ScreenMessage, ScreenMessageRole,
};
use linux_archductor_core::session_event::{
    codex_parsed_item_to_session_event, parse_codex_screen_event_delta, SessionCommandOutputStatus,
    SessionEvent, SessionEventPayload, SessionEventSource, SessionEventStatus, SessionInputKind,
    SessionMetadataValue, SessionPromptOption, SessionPromptStyle,
};

#[test]
fn event_model_serializes_all_required_event_families_with_raw_text() {
    let events = vec![
        SessionEvent::new(
            SessionEventSource::User,
            Some("› run tests".to_owned()),
            SessionEventPayload::UserInput {
                text: "run tests".to_owned(),
                kind: SessionInputKind::User,
            },
        ),
        SessionEvent::new(
            SessionEventSource::Assistant,
            Some("• Running tests".to_owned()),
            SessionEventPayload::AssistantText {
                text: "Running tests".to_owned(),
            },
        ),
        SessionEvent::new(
            SessionEventSource::Runtime,
            Some("Ran cargo test\nok".to_owned()),
            SessionEventPayload::CommandOutput {
                title: "cargo test".to_owned(),
                output: "ok".to_owned(),
                status: SessionCommandOutputStatus::Succeeded,
            },
        ),
        SessionEvent::new(
            SessionEventSource::System,
            None,
            SessionEventPayload::StatusChange {
                status: SessionEventStatus::WaitingForInput,
                message: Some("ready".to_owned()),
            },
        ),
        SessionEvent::new(
            SessionEventSource::Runtime,
            Some("fatal: missing binary".to_owned()),
            SessionEventPayload::Error {
                message: "missing binary".to_owned(),
                recoverable: false,
            },
        ),
        SessionEvent::new(
            SessionEventSource::Assistant,
            Some("Do you trust this directory?".to_owned()),
            SessionEventPayload::Prompt {
                style: SessionPromptStyle::Confirmation,
                text: "Do you trust this directory?".to_owned(),
                options: vec![SessionPromptOption {
                    label: "Yes, continue".to_owned(),
                    value: "yes".to_owned(),
                }],
            },
        ),
        SessionEvent::new(
            SessionEventSource::Runtime,
            None,
            SessionEventPayload::Metadata {
                entries: [(
                    "context_percent".to_owned(),
                    SessionMetadataValue::Number(42.into()),
                )]
                .into(),
            },
        ),
    ];

    let json = serde_json::to_string(&events).unwrap();
    let decoded: Vec<SessionEvent> = serde_json::from_str(&json).unwrap();

    assert_eq!(decoded, events);
    assert!(json.contains("\"raw_text\":\"› run tests\""));
    assert!(json.contains("\"type\":\"command_output\""));
    assert!(json.contains("\"type\":\"prompt\""));
}

#[test]
fn codex_parser_items_map_to_ui_neutral_session_events() {
    let message = CodexParsedItem::Message(ScreenMessage {
        role: ScreenMessageRole::Agent,
        content: "Done.".to_owned(),
    });
    assert_eq!(
        codex_parsed_item_to_session_event(message),
        SessionEvent::new(
            SessionEventSource::Assistant,
            Some("Done.".to_owned()),
            SessionEventPayload::AssistantText {
                text: "Done.".to_owned(),
            },
        )
    );

    let command = CodexParsedItem::Event(CodexTranscriptEvent::Tool {
        title: "cargo test".to_owned(),
        body: "test result: ok".to_owned(),
    });
    assert_eq!(
        codex_parsed_item_to_session_event(command),
        SessionEvent::new(
            SessionEventSource::Runtime,
            Some("Ran cargo test\ntest result: ok".to_owned()),
            SessionEventPayload::CommandOutput {
                title: "cargo test".to_owned(),
                output: "test result: ok".to_owned(),
                status: SessionCommandOutputStatus::Unknown,
            },
        )
    );
}

#[test]
fn codex_screen_delta_can_be_rendered_without_terminal_assumptions() {
    let screen = "\
› latest question
• before tool
Ran cargo test
running
• after tool
";
    let delta = linux_archductor_core::codex_tui::parse_codex_screen_delta(
        screen,
        &CodexParseBenchmark {
            last_user_message: Some("latest question".to_owned()),
            last_agent_message: None,
        },
        None,
    );

    let events = delta
        .items
        .into_iter()
        .map(codex_parsed_item_to_session_event)
        .collect::<Vec<_>>();

    assert_eq!(
        events
            .iter()
            .map(|event| event.render_text())
            .collect::<Vec<_>>(),
        vec!["before tool", "cargo test\nrunning", "after tool"]
    );
}

#[test]
fn codex_screen_event_delta_returns_appendable_session_events_with_cursor() {
    let screen = "\
› latest question
• first answer
";
    let delta = parse_codex_screen_event_delta(
        screen,
        &CodexParseBenchmark {
            last_user_message: Some("latest question".to_owned()),
            last_agent_message: None,
        },
        None,
    );

    assert_eq!(delta.cursor.fingerprint.as_deref(), Some(screen));
    assert_eq!(
        delta.events,
        vec![SessionEvent::new(
            SessionEventSource::Assistant,
            Some("first answer".to_owned()),
            SessionEventPayload::AssistantText {
                text: "first answer".to_owned(),
            },
        )]
    );
}
