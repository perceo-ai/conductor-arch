use archductor_core::codex_tui::{
    CodexParseBenchmark, CodexParsedItem, CodexTranscriptEvent, ScreenMessage, ScreenMessageRole,
};
use archductor_core::session_event::{
    codex_parsed_item_to_session_event, parse_codex_screen_event_delta, SessionCommandOutputStatus,
    SessionEvent, SessionEventPayload, SessionEventSource, SessionEventStatus, SessionInputKind,
    SessionMetadataValue, SessionPromptOption, SessionPromptStyle,
};
use archductor_core::session_pipeline::{
    process_codex_pty_pipeline, PtyChunkInput, SessionPipelineInput,
};
use archductor_core::session_state::{AgentSessionState, SessionStateMachine};

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
                status: SessionCommandOutputStatus::Succeeded,
            },
        )
    );
}

#[test]
fn codex_parser_items_map_prompts_and_errors_to_typed_session_events() {
    let prompt = CodexParsedItem::Message(ScreenMessage {
        role: ScreenMessageRole::Agent,
        content: "Do you trust the contents of this directory?\n1. Yes, continue\n2. No, exit"
            .to_owned(),
    });
    assert_eq!(
        codex_parsed_item_to_session_event(prompt),
        SessionEvent::new(
            SessionEventSource::Assistant,
            Some(
                "Do you trust the contents of this directory?\n1. Yes, continue\n2. No, exit"
                    .to_owned()
            ),
            SessionEventPayload::Prompt {
                style: SessionPromptStyle::Confirmation,
                text: "Do you trust the contents of this directory?".to_owned(),
                options: vec![
                    SessionPromptOption {
                        label: "Yes, continue".to_owned(),
                        value: "yes".to_owned(),
                    },
                    SessionPromptOption {
                        label: "No, exit".to_owned(),
                        value: "no".to_owned(),
                    },
                ],
            },
        )
    );

    let error = CodexParsedItem::Message(ScreenMessage {
        role: ScreenMessageRole::Agent,
        content: "Error: missing permission".to_owned(),
    });
    assert_eq!(
        codex_parsed_item_to_session_event(error),
        SessionEvent::new(
            SessionEventSource::Assistant,
            Some("Error: missing permission".to_owned()),
            SessionEventPayload::Error {
                message: "Error: missing permission".to_owned(),
                recoverable: false,
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
    let delta = archductor_core::codex_tui::parse_codex_screen_delta(
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

    assert_eq!(
        delta.cursor.fingerprint.as_deref(),
        Some("› latest question\n• first answer")
    );
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

#[test]
fn codex_pipeline_maps_chunk_backed_screen_to_events_and_state() {
    let input = SessionPipelineInput {
        chunks: vec![
            PtyChunkInput {
                sequence: 1,
                text: "› run tests\n".to_owned(),
            },
            PtyChunkInput {
                sequence: 2,
                text: "• Working\nRan cargo test\nrunning\n".to_owned(),
            },
        ],
        screen: "› run tests\n• Working\nRan cargo test\nrunning\n".to_owned(),
        benchmark: CodexParseBenchmark {
            last_user_message: Some("run tests".to_owned()),
            last_agent_message: None,
        },
        previous_cursor: None,
        previous_state: AgentSessionState::Running,
    };

    let output = process_codex_pty_pipeline(input);

    assert_eq!(output.chunk_range, Some((1, 2)));
    assert_eq!(
        output.normalized_text,
        "› run tests\n• Working\nRan cargo test\nrunning\n"
    );
    assert_eq!(
        output
            .events
            .iter()
            .map(SessionEvent::render_text)
            .collect::<Vec<_>>(),
        vec!["Working", "cargo test\nrunning"]
    );
    assert_eq!(output.state, AgentSessionState::ToolRunning);
    assert!(!output.ready_for_input);
}

#[test]
fn codex_pipeline_emits_trust_prompt_as_waiting_state() {
    let prompt = "Do you trust the contents of this directory?\n1. Yes, continue\n2. No, exit";
    let output = process_codex_pty_pipeline(SessionPipelineInput {
        chunks: vec![PtyChunkInput {
            sequence: 5,
            text: prompt.to_owned(),
        }],
        screen: prompt.to_owned(),
        benchmark: CodexParseBenchmark::default(),
        previous_cursor: None,
        previous_state: AgentSessionState::Starting,
    });

    assert_eq!(output.chunk_range, Some((5, 5)));
    assert_eq!(output.state, AgentSessionState::WaitingForInput);
    assert!(output.trust_prompt);
    assert!(matches!(
        output.events.first().map(|event| &event.payload),
        Some(SessionEventPayload::Prompt { .. })
    ));
}

#[test]
fn session_state_machine_tracks_agent_runtime_states_and_invalid_transitions() {
    let mut machine = SessionStateMachine::new();

    assert_eq!(machine.state(), AgentSessionState::Starting);

    machine.apply_event(&SessionEvent::new(
        SessionEventSource::Runtime,
        None,
        SessionEventPayload::StatusChange {
            status: SessionEventStatus::Running,
            message: None,
        },
    ));
    assert_eq!(machine.state(), AgentSessionState::Running);

    machine.apply_event(&SessionEvent::new(
        SessionEventSource::Assistant,
        Some("working".to_owned()),
        SessionEventPayload::AssistantText {
            text: "working".to_owned(),
        },
    ));
    assert_eq!(machine.state(), AgentSessionState::Streaming);

    machine.apply_event(&SessionEvent::new(
        SessionEventSource::Runtime,
        Some("Ran cargo test".to_owned()),
        SessionEventPayload::CommandOutput {
            title: "cargo test".to_owned(),
            output: "running".to_owned(),
            status: SessionCommandOutputStatus::Running,
        },
    ));
    assert_eq!(machine.state(), AgentSessionState::ToolRunning);

    machine.apply_event(&SessionEvent::new(
        SessionEventSource::System,
        None,
        SessionEventPayload::Prompt {
            style: SessionPromptStyle::Confirmation,
            text: "Do you trust the contents of this directory?".to_owned(),
            options: Vec::new(),
        },
    ));
    assert_eq!(machine.state(), AgentSessionState::WaitingForInput);

    machine.mark_interrupted("user stopped session");
    assert_eq!(machine.state(), AgentSessionState::Interrupted);

    machine.apply_event(&SessionEvent::new(
        SessionEventSource::Assistant,
        Some("late output".to_owned()),
        SessionEventPayload::AssistantText {
            text: "late output".to_owned(),
        },
    ));
    assert_eq!(machine.state(), AgentSessionState::Interrupted);
    assert_eq!(machine.invalid_transitions().len(), 1);

    machine.mark_archived();
    assert_eq!(machine.state(), AgentSessionState::Archived);
}
