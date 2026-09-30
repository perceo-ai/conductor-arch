//! `archductor chat` and `archductor status`: reading the board without
//! reading logs.
//!
//! Both are written for a caller on a slow, fragile link (an agent polling
//! through a VM guest agent) as much as for a person: small by default, ASCII
//! only (so nothing grows when the transport escapes it), one line per thing,
//! and a `--json` form with a documented, versioned shape.

use anyhow::{Context, Result};
use archductor_core::agent_status::{
    collect_status, now_ms, session_report, AgentActivity, LiveProbe, SessionReport,
    SessionSignals, StatusReport, WorkspaceReport,
};
use archductor_core::archcar::client::ArchcarClient;
use archductor_core::archcar::protocol::{ArchcarRequest, ArchcarResponse};
use archductor_core::chat_transcript::{
    build_chat_transcript, parse_rfc3339_ms, select_turns, EntryKind, TranscriptOptions,
    TranscriptTurn,
};
use archductor_core::paths::AppPaths;
use archductor_core::provider_events::ProviderEventStore;
use archductor_core::provider_interactions::ProviderInteractionStore;
use archductor_core::session_state::AgentSessionState;
use archductor_core::workspace::{ProcessRecord, WorkspaceStore};
use std::fmt::Write as _;

/// Version of the `chat --json` records. Bump on any breaking change.
pub const CHAT_SCHEMA_VERSION: u32 = 1;

/// Ask the daemon, which owns every agent process, whether a session is alive.
/// `None` means "the daemon could not say" and the caller checks the PID; once
/// the daemon is unreachable it is not asked again.
pub fn daemon_probe(
    client: &ArchcarClient,
) -> impl FnMut(&ProcessRecord) -> Option<LiveProbe> + '_ {
    let mut reachable = true;
    move |process| {
        if !reachable {
            return None;
        }
        match client.send(ArchcarRequest::GetSessionStatus {
            session_id: process.id,
        }) {
            Ok(ArchcarResponse::SessionStatus {
                status,
                runtime_state,
                ..
            }) => Some(LiveProbe {
                alive: !session_is_terminal(&status, runtime_state),
                runtime_state: Some(runtime_state),
            }),
            // The daemon does not hold this session; only the PID can say.
            Ok(_) => None,
            Err(_) => {
                reachable = false;
                None
            }
        }
    }
}

pub fn session_is_terminal(status: &str, runtime_state: AgentSessionState) -> bool {
    status != "running"
        || matches!(
            runtime_state,
            AgentSessionState::Interrupted
                | AgentSessionState::Failed
                | AgentSessionState::Exited
                | AgentSessionState::Archived
        )
}

pub fn status_report(
    paths: &AppPaths,
    store: &WorkspaceStore,
    workspace: Option<&str>,
) -> Result<StatusReport> {
    let client = ArchcarClient::from_paths(paths);
    let mut probe = daemon_probe(&client);
    collect_status(store, &paths.database_path, workspace, now_ms(), &mut probe)
}

pub fn render_status_json(report: &StatusReport) -> Result<String> {
    Ok(format!("{}\n", serde_json::to_string(report)?))
}

/// Provider text (file contents, command output, chat titles) can carry
/// terminal control sequences, and a crafted one would drive the operator's
/// terminal: move the cursor, rewrite lines, set the clipboard (OSC 52). Our
/// own formatting emits only newlines, so every other control character in
/// the text output is shown escaped instead (`\x1b`, `\u{9b}`). The JSON
/// forms are escaped by the serializer.
pub fn terminal_safe(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\n' | '\t' => out.push(c),
            c if (c as u32) < 0x80 && c.is_control() => {
                let _ = write!(out, "\\x{:02x}", c as u32);
            }
            c if c.is_control() => {
                let _ = write!(out, "\\u{{{:x}}}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

pub fn render_status_text(report: &StatusReport) -> String {
    terminal_safe(&status_text(report))
}

fn status_text(report: &StatusReport) -> String {
    if report.workspaces.is_empty() {
        return "No workspaces found. Run: archductor workspace create <repo> --name <name> --branch <branch>\n"
            .to_owned();
    }
    let mut out = String::new();
    for ws in &report.workspaces {
        let pr = ws
            .pr
            .as_ref()
            .map(|pr| format!("PR #{} ({})", pr.number, pr.state))
            .unwrap_or_else(|| "no PR".to_owned());
        let push = match (ws.has_upstream, ws.ahead, ws.behind) {
            (Some(false), _, _) => "no upstream".to_owned(),
            (_, Some(ahead), Some(behind)) => format!("↑{ahead} ↓{behind}"),
            _ => String::new(),
        };
        let _ = writeln!(
            out,
            "{:<16} {:<10} {:<28} {:<14} run:{:<8} {:<22} {} todo(s)  {}",
            ws.workspace,
            ws.status,
            ws.branch,
            push,
            ws.run_script,
            agent_summary(ws),
            ws.open_todos,
            pr,
        );
    }
    out
}

/// "no agent", "agent working", or "agents 2 working, 1 finished".
fn agent_summary(ws: &WorkspaceReport) -> String {
    let order = [
        AgentActivity::AwaitingInput,
        AgentActivity::Failed,
        AgentActivity::Working,
        AgentActivity::Finished,
        AgentActivity::Stopped,
    ];
    match ws.sessions.as_slice() {
        [] => "no agent".to_owned(),
        [one] => format!("agent {}", one.state.as_str()),
        many => {
            let counts = order
                .iter()
                .filter_map(|state| {
                    let count = many.iter().filter(|s| s.state == *state).count();
                    (count > 0).then(|| format!("{count} {}", state.as_str()))
                })
                .collect::<Vec<_>>();
            format!("agents {}", counts.join(", "))
        }
    }
}

pub struct ChatArgs {
    pub workspace: String,
    pub session: Option<i64>,
    pub thread: Option<i64>,
    pub tail: usize,
    pub steps: usize,
    pub since: Option<String>,
    pub json: bool,
    pub no_thinking: bool,
    pub full: bool,
}

pub fn run_chat(paths: &AppPaths, store: &WorkspaceStore, args: ChatArgs) -> Result<String> {
    let since_ms = args
        .since
        .as_deref()
        .map(|since| {
            parse_rfc3339_ms(since).with_context(|| {
                format!("--since {since:?} is not an RFC 3339 time like 2026-09-30T08:00:00Z")
            })
        })
        .transpose()?;
    let workspace = store
        .list()?
        .into_iter()
        .find(|workspace| workspace.name == args.workspace)
        .with_context(|| format!("workspace {} not found", args.workspace))?;
    let events = ProviderEventStore::new(&paths.database_path);
    let threads = store.list_chat_threads(&workspace.name)?;
    let sessions = store.list_sessions(&workspace.name)?;

    let thread_id = match (args.session, args.thread) {
        (Some(_), Some(_)) => anyhow::bail!("pass --session or --thread, not both"),
        (Some(session_id), None) => {
            let process = sessions
                .iter()
                .find(|process| process.id == session_id)
                .with_context(|| {
                    format!(
                        "session {session_id} is not in workspace {}",
                        workspace.name
                    )
                })?;
            process
                .chat_thread_id
                .with_context(|| format!("session {session_id} is not an agent chat"))?
        }
        (None, Some(thread_id)) => {
            let thread = store.get_chat_thread_record(thread_id)?;
            anyhow::ensure!(
                thread.workspace_id == workspace.id,
                "chat thread {thread_id} is not in workspace {}",
                workspace.name
            );
            thread_id
        }
        (None, None) => {
            // The chat that streamed most recently is the one being asked about.
            let mut best = None;
            for thread in &threads {
                let last = events.last_occurred_at_ms_for_chat_thread(thread.id)?;
                if best.is_none_or(|(_, best_last)| last > best_last) {
                    best = Some((thread.id, last));
                }
            }
            best.map(|(id, _)| id)
                .with_context(|| format!("workspace {} has no agent chats yet", workspace.name))?
        }
    };
    let thread = store.get_chat_thread_record(thread_id)?;
    let records = events.list_for_chat_thread(thread_id)?;
    let turns = build_chat_transcript(
        &records,
        &TranscriptOptions {
            workspace_root: Some(&workspace.path),
            include_thinking: !args.no_thinking,
            full: args.full,
        },
    );
    let session = sessions
        .iter()
        .filter(|process| process.chat_thread_id == Some(thread_id))
        .max_by_key(|process| process.id)
        .map(|process| {
            let client = ArchcarClient::from_paths(paths);
            let mut probe = daemon_probe(&client);
            session_report(
                store,
                &ProviderInteractionStore::new(paths.database_path.clone()),
                SessionSignals {
                    process,
                    thread: Some(&thread),
                    records: &records,
                    turns: &turns,
                },
                now_ms(),
                &mut probe,
            )
        });
    let total = turns.len();
    let shown = select_turns(
        turns,
        since_ms,
        args.tail.max(1),
        (!args.full).then_some(args.steps),
    );
    let other_threads = threads
        .iter()
        .filter(|other| other.id != thread_id)
        .map(|other| other.id)
        .collect::<Vec<_>>();
    let header = ChatHeader {
        workspace: &workspace.name,
        thread_id,
        title: &thread.title,
        provider: &thread.provider,
        session: session.as_ref(),
        turns_total: total,
        other_threads: &other_threads,
    };
    if args.json {
        render_chat_json(&header, &shown)
    } else {
        Ok(render_chat_text(&header, &shown))
    }
}

pub struct ChatHeader<'a> {
    pub workspace: &'a str,
    pub thread_id: i64,
    pub title: &'a str,
    pub provider: &'a str,
    pub session: Option<&'a SessionReport>,
    pub turns_total: usize,
    pub other_threads: &'a [i64],
}

/// JSON Lines: one `chat` record, then one `turn` record per turn shown.
pub fn render_chat_json(header: &ChatHeader<'_>, turns: &[TranscriptTurn]) -> Result<String> {
    let mut out = serde_json::to_string(&serde_json::json!({
        "type": "chat",
        "schema_version": CHAT_SCHEMA_VERSION,
        "workspace": header.workspace,
        "thread_id": header.thread_id,
        "title": header.title,
        "provider": header.provider,
        "session": header.session,
        "turns_total": header.turns_total,
        "turns_shown": turns.len(),
        "other_threads": header.other_threads,
    }))?;
    out.push('\n');
    for turn in turns {
        let mut record = serde_json::to_value(turn)?;
        if let Some(object) = record.as_object_mut() {
            object.insert("type".to_owned(), "turn".into());
        }
        out.push_str(&serde_json::to_string(&record)?);
        out.push('\n');
    }
    Ok(out)
}

pub fn render_chat_text(header: &ChatHeader<'_>, turns: &[TranscriptTurn]) -> String {
    terminal_safe(&chat_text(header, turns))
}

fn chat_text(header: &ChatHeader<'_>, turns: &[TranscriptTurn]) -> String {
    let mut out = format!(
        "chat {} thread {} {} \"{}\"",
        header.workspace, header.thread_id, header.provider, header.title
    );
    match header.session {
        Some(session) => {
            let _ = write!(
                out,
                " | session {} {}{}",
                session.session_id,
                session.state.as_str(),
                if session.alive { "" } else { " (not running)" }
            );
            if let Some(idle) = session.idle_seconds {
                let _ = write!(out, ", idle {}", human_duration(idle));
            }
            if let Some(tool) = &session.current_tool {
                let _ = write!(out, ", in {tool}");
            }
            if session.pending_interactions > 0 {
                let _ = write!(out, ", {} prompt(s) waiting", session.pending_interactions);
            }
            if session.queued_inputs > 0 {
                let _ = write!(out, ", {} queued", session.queued_inputs);
            }
            if let Some(url) = &session.pr_url {
                let _ = write!(out, " | pr {url}");
            }
        }
        None => out.push_str(" | no session"),
    }
    let _ = writeln!(
        out,
        " | turns {} (showing {})",
        header.turns_total,
        turns.len()
    );
    if !header.other_threads.is_empty() {
        let ids = header
            .other_threads
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let _ = writeln!(out, "other chats: {ids} (--thread N)");
    }
    for turn in turns {
        let _ = write!(out, "== turn {} {}", turn.turn, turn.outcome.as_str());
        if let Some(started) = &turn.started_at {
            let _ = write!(out, " {started}");
        }
        if let Some(ended) = &turn.ended_at {
            let _ = write!(out, " .. {ended}");
        }
        out.push_str(" ==\n");
        let mut entries = turn.entries.iter().peekable();
        if let Some(first) = entries.next_if(|entry| entry.kind == EntryKind::User) {
            let _ = writeln!(out, "user: {}", first.text);
        }
        if turn.elided > 0 {
            let _ = writeln!(
                out,
                "  ... {} earlier step(s) not shown (--full shows all)",
                turn.elided
            );
        }
        for entry in entries {
            let pad = if entry.nested { "  | " } else { "  " };
            let running = match entry.status.as_str() {
                "running" | "pending" if entry.kind != EntryKind::User => " [running]",
                _ => "",
            };
            let tool = entry.tool.as_deref().unwrap_or_default();
            let labelled = |text: &str| match (tool.is_empty(), text.is_empty()) {
                (true, _) => text.to_owned(),
                (false, true) => tool.to_owned(),
                (false, false) => format!("{tool}: {text}"),
            };
            match entry.kind {
                EntryKind::User => {
                    let _ = writeln!(out, "user: {}", entry.text);
                }
                EntryKind::Assistant => {
                    let mut lines = entry.text.lines();
                    let _ = writeln!(out, "assistant: {}", lines.next().unwrap_or_default());
                    for line in lines {
                        let _ = writeln!(out, "  {line}");
                    }
                }
                EntryKind::Thinking => {
                    let _ = writeln!(out, "{pad}thinking {}", entry.text);
                }
                EntryKind::Tool | EntryKind::Event => {
                    let _ = writeln!(out, "{pad}{}{running}", labelled(&entry.text));
                }
                EntryKind::Error => {
                    let _ = writeln!(out, "{pad}ERROR {}", labelled(&entry.text));
                }
                EntryKind::Prompt => {
                    let _ = writeln!(
                        out,
                        "{pad}PROMPT {} {}",
                        entry.status,
                        labelled(&entry.text)
                    );
                }
            }
            if let Some(result) = &entry.result {
                let _ = writeln!(out, "{pad}  -> {result}");
            }
        }
        if !turn.pr_urls.is_empty() {
            let _ = writeln!(out, "  pr: {}", turn.pr_urls.join(" "));
        }
    }
    out
}

fn human_duration(seconds: u64) -> String {
    match seconds {
        0..=119 => format!("{seconds}s"),
        120..=7199 => format!("{}m", seconds / 60),
        _ => format!("{}h", seconds / 3600),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use archductor_core::agent_status::LivenessSource;
    use archductor_core::chat_transcript::{TranscriptEntry, TurnOutcome};

    fn entry(kind: EntryKind, tool: Option<&str>, text: &str, status: &str) -> TranscriptEntry {
        TranscriptEntry {
            kind,
            at: None,
            tool: tool.map(ToOwned::to_owned),
            text: text.to_owned(),
            status: status.to_owned(),
            result: None,
            truncated: false,
            nested: false,
            at_ms: None,
        }
    }

    fn session(state: AgentActivity) -> SessionReport {
        SessionReport {
            session_id: 9,
            thread_id: Some(12),
            kind: "claude".to_owned(),
            title: Some("Run the tests".to_owned()),
            alive: true,
            liveness_source: LivenessSource::Daemon,
            state,
            last_activity: Some("2026-09-30T08:41:52Z".to_owned()),
            idle_seconds: Some(3),
            current_tool: Some("Bash: cargo clippy".to_owned()),
            turn_outcome: Some(TurnOutcome::Running),
            turns: 2,
            pending_interactions: 0,
            queued_inputs: 1,
            pr_url: None,
        }
    }

    #[test]
    fn chat_text_is_ascii_one_line_per_step_with_errors_called_out() {
        let mut edit = entry(EntryKind::Error, Some("Edit"), "src/a.rs", "failed");
        edit.result = Some("File has not been read yet.".to_owned());
        let mut bash = entry(EntryKind::Tool, Some("Bash"), "cargo test", "complete");
        bash.result = Some("ok. 3 passed".to_owned());
        let turn = TranscriptTurn {
            turn: 2,
            started_at: Some("2026-09-30T08:41:52Z".to_owned()),
            ended_at: None,
            outcome: TurnOutcome::Running,
            elided: 4,
            entries: vec![
                entry(EntryKind::User, None, "run the tests", "running"),
                entry(EntryKind::Thinking, None, "~40 tokens", "complete"),
                bash,
                edit,
                entry(
                    EntryKind::Prompt,
                    None,
                    "Approval: Bash rm -rf target",
                    "pending",
                ),
                entry(EntryKind::Tool, Some("Bash"), "cargo clippy", "running"),
                entry(
                    EntryKind::Assistant,
                    None,
                    "Two lines\nof prose",
                    "complete",
                ),
            ],
            pr_urls: Vec::new(),
            started_ms: None,
            ended_ms: None,
        };
        let session = session(AgentActivity::Working);
        let header = ChatHeader {
            workspace: "berlin",
            thread_id: 12,
            title: "Run the tests",
            provider: "claude",
            session: Some(&session),
            turns_total: 2,
            other_threads: &[11],
        };

        let text = render_chat_text(&header, &[turn]);

        assert_eq!(
            text,
            "chat berlin thread 12 claude \"Run the tests\" | session 9 working, idle 3s, in Bash: cargo clippy, 1 queued | turns 2 (showing 1)\n\
             other chats: 11 (--thread N)\n\
             == turn 2 running 2026-09-30T08:41:52Z ==\n\
             user: run the tests\n\
             \x20 ... 4 earlier step(s) not shown (--full shows all)\n\
             \x20 thinking ~40 tokens\n\
             \x20 Bash: cargo test\n\
             \x20   -> ok. 3 passed\n\
             \x20 ERROR Edit: src/a.rs\n\
             \x20   -> File has not been read yet.\n\
             \x20 PROMPT pending Approval: Bash rm -rf target\n\
             \x20 Bash: cargo clippy [running]\n\
             assistant: Two lines\n\
             \x20 of prose\n"
        );
        assert!(text.is_ascii());
    }

    #[test]
    fn provider_text_cannot_drive_the_operators_terminal() {
        // An OSC 52 clipboard write, a CSI cursor move, a carriage return that
        // would overwrite the line, and an 8-bit CSI.
        let mut read = entry(EntryKind::Tool, Some("Read"), "evil.txt", "complete");
        read.result = Some("a\u{1b}]52;c;aGk=\u{7}b\u{1b}[2Jc\rd\u{9b}e".to_owned());
        let turn = TranscriptTurn {
            turn: 1,
            started_at: None,
            ended_at: None,
            outcome: TurnOutcome::Success,
            elided: 0,
            entries: vec![entry(EntryKind::User, None, "look", "running"), read],
            pr_urls: Vec::new(),
            started_ms: None,
            ended_ms: None,
        };
        let header = ChatHeader {
            workspace: "berlin",
            thread_id: 1,
            title: "title\u{1b}[31m",
            provider: "claude",
            session: None,
            turns_total: 1,
            other_threads: &[],
        };

        let text = render_chat_text(&header, &[turn]);

        assert!(
            !text.chars().any(|c| c.is_control() && c != '\n'),
            "{text:?}"
        );
        assert!(
            text.contains("-> a\\x1b]52;c;aGk=\\x07b\\x1b[2Jc\\x0dd\\u{9b}e"),
            "{text}"
        );
        assert!(text.contains("\"title\\x1b[31m\""), "{text}");
    }

    #[test]
    fn chat_json_is_one_record_per_line_with_a_versioned_header() {
        let session = session(AgentActivity::Finished);
        let header = ChatHeader {
            workspace: "berlin",
            thread_id: 12,
            title: "t",
            provider: "claude",
            session: Some(&session),
            turns_total: 1,
            other_threads: &[],
        };
        let turn = TranscriptTurn {
            turn: 1,
            started_at: None,
            ended_at: None,
            outcome: TurnOutcome::Success,
            elided: 0,
            entries: vec![entry(EntryKind::User, None, "hi", "running")],
            pr_urls: vec!["https://github.com/o/r/pull/1".to_owned()],
            started_ms: None,
            ended_ms: None,
        };

        let json = render_chat_json(&header, &[turn]).unwrap();
        let lines = json
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["type"], "chat");
        assert_eq!(lines[0]["schema_version"], CHAT_SCHEMA_VERSION);
        assert_eq!(lines[0]["session"]["state"], "finished");
        assert_eq!(lines[1]["type"], "turn");
        assert_eq!(lines[1]["outcome"], "success");
        assert_eq!(lines[1]["pr_urls"][0], "https://github.com/o/r/pull/1");
        assert_eq!(lines[1]["entries"][0]["kind"], "user");
    }

    #[test]
    fn plain_status_names_the_run_script_and_the_agents_separately() {
        let working = session(AgentActivity::Working);
        let mut finished = session(AgentActivity::Finished);
        finished.session_id = 8;
        let report = StatusReport {
            schema_version: 1,
            generated_at: "2026-09-30T08:41:52Z".to_owned(),
            workspaces: vec![WorkspaceReport {
                workspace: "berlin".to_owned(),
                repository: "demo".to_owned(),
                status: "active".to_owned(),
                branch: "lc/berlin".to_owned(),
                has_upstream: Some(false),
                ahead: None,
                behind: None,
                additions: 0,
                deletions: 0,
                open_todos: 0,
                run_script: "stopped".to_owned(),
                state: Some(AgentActivity::Working),
                pr: None,
                pr_url: None,
                sessions: vec![working, finished],
            }],
        };

        let text = render_status_text(&report);

        assert!(text.contains(" run:stopped "), "{text}");
        assert!(text.contains("agents 1 working, 1 finished"), "{text}");
        assert!(!text.contains(" stopped    "), "{text}");
    }
}
