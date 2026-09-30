//! A chat as turns an operator can read in a few kilobytes.
//!
//! `archductor logs --session` is the raw provider stream — token deltas, not
//! prose. This starts from the same projection the desktop timeline renders
//! (so both surfaces agree on what happened), groups it into turns at each user
//! message, and squeezes every card to one line: the tool and a short argument,
//! its result clipped with a visible marker, thinking reduced to a marker.
//! Turn outcomes and PR links come from the provider's own turn records, so a
//! caller learns "done, and here is the PR" without grepping a log.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::provider_adapters::claude_stream::assistant_tool_calls;
use crate::provider_events::{ProviderEventKind, ProviderEventPhase, ProviderEventRecord};
use crate::provider_projection::{
    drop_echoed_user_messages, provider_projection_canonical_id, provider_projection_from_records,
    provider_projection_item_is_relevant_chat_event, ProjectionRenderClass, ProviderProjectionItem,
    ProviderProjectionStatus,
};

/// Clip budgets for the default (non `--full`) transcript. Sized so a handful
/// of turns stays inside a 4 KB-friendly reply.
const USER_TEXT_LIMIT: usize = 200;
const ASSISTANT_TEXT_LIMIT: usize = 400;
const TOOL_ARG_LIMIT: usize = 80;
const TOOL_RESULT_LIMIT: usize = 80;
/// Entries shown per turn before the earliest are elided.
pub const DEFAULT_MAX_TURN_ENTRIES: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome {
    /// The newest turn has no completion record yet.
    Running,
    Success,
    Failed,
    Interrupted,
    /// An older turn that never recorded an outcome (the session died, or a
    /// steering message split it).
    Unknown,
}

impl TurnOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    User,
    Assistant,
    Thinking,
    Tool,
    /// A permission prompt or question waiting on a human.
    Prompt,
    Error,
    /// Plans, background tasks, warnings: worth a line, not a tool call.
    Event,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TranscriptEntry {
    pub kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Prose for user/assistant entries; the argument summary for a tool.
    pub text: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// Some text in this entry was clipped; the clipped text ends in `...[+N chars]`.
    #[serde(skip_serializing_if = "is_false")]
    pub truncated: bool,
    /// Work done by a subagent, under the Agent call that spawned it.
    #[serde(skip_serializing_if = "is_false")]
    pub nested: bool,
    #[serde(skip)]
    pub at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TranscriptTurn {
    /// 1-based position of the turn in the whole chat.
    pub turn: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub outcome: TurnOutcome,
    /// Earlier entries left out of this turn to keep the output small.
    #[serde(skip_serializing_if = "is_zero")]
    pub elided: usize,
    pub entries: Vec<TranscriptEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pr_urls: Vec<String>,
    #[serde(skip)]
    pub started_ms: Option<u64>,
    #[serde(skip)]
    pub ended_ms: Option<u64>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

#[derive(Debug, Clone, Default)]
pub struct TranscriptOptions<'a> {
    /// Stripped from paths in tool arguments, so `Edit /home/.../ws/src/a.rs`
    /// reads `Edit src/a.rs`.
    pub workspace_root: Option<&'a Path>,
    pub include_thinking: bool,
    /// Keep every character: no clipping of prose, arguments, or results.
    pub full: bool,
}

/// Every turn of a chat, oldest first.
pub fn build_chat_transcript(
    records: &[ProviderEventRecord],
    options: &TranscriptOptions<'_>,
) -> Vec<TranscriptTurn> {
    let mut times = HashMap::<String, (u64, u64)>::new();
    // A streamed tool call is named before its input arrives, and the card
    // keeps that bare name until the result lands — exactly while a caller
    // asks "what is it doing". The assembled assistant message has the input.
    let mut tool_use_ids = HashMap::<String, String>::new();
    let mut targets = HashMap::<String, String>::new();
    for record in records {
        let at = record.occurred_at_ms;
        let id = provider_projection_canonical_id(record);
        if let Some(item_id) = record.provider_item_id.as_deref() {
            tool_use_ids.insert(id.clone(), item_id.to_owned());
        }
        times
            .entry(id)
            .and_modify(|(first, last)| {
                *first = (*first).min(at);
                *last = (*last).max(at);
            })
            .or_insert((at, at));
        for (use_id, _, target) in assistant_tool_calls(&record.raw_json) {
            if let Some(target) = target {
                targets.insert(use_id, target);
            }
        }
    }

    let items = drop_echoed_user_messages(provider_projection_from_records(records).items)
        .into_iter()
        .filter(provider_projection_item_is_relevant_chat_event)
        .collect::<Vec<_>>();
    let ids = items
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();
    let root = options
        .workspace_root
        .map(|root| format!("{}/", root.display().to_string().trim_end_matches('/')));

    let mut turns = Vec::<TranscriptTurn>::new();
    for item in &items {
        let nested = item
            .parent_id
            .as_deref()
            .is_some_and(|parent| ids.contains(parent));
        let at_ms = times.get(&item.id).map(|(first, _)| *first);
        // Claude replays a background task's completion as a user message with
        // no text of its own, mid-turn. It is news for the agent, not a request.
        let starts_turn = item.render_class == ProjectionRenderClass::UserChat
            && !nested
            && !item.body.trim().is_empty();
        if starts_turn || turns.is_empty() {
            turns.push(TranscriptTurn {
                turn: turns.len() + 1,
                started_at: None,
                ended_at: None,
                outcome: TurnOutcome::Unknown,
                elided: 0,
                entries: Vec::new(),
                pr_urls: Vec::new(),
                started_ms: at_ms,
                ended_ms: None,
            });
        }
        let turn = turns.last_mut().expect("a turn was just ensured");
        let target = tool_use_ids
            .get(&item.id)
            .and_then(|use_id| targets.get(use_id))
            .map(String::as_str);
        if creates_pull_request(item, target) {
            for url in find_pr_urls(&item.body) {
                if !turn.pr_urls.contains(&url) {
                    turn.pr_urls.push(url);
                }
            }
        }
        if let Some(mut entry) = transcript_entry(item, target, root.as_deref(), options) {
            entry.nested = nested;
            entry.at_ms = at_ms;
            entry.at = at_ms.map(rfc3339_from_ms);
            // The same card can project twice (a streamed block and the final
            // message); one line says it.
            let repeat = turn.entries.last().is_some_and(|last| {
                (last.kind, &last.tool, &last.text, &last.result)
                    == (entry.kind, &entry.tool, &entry.text, &entry.result)
            });
            if !repeat {
                turn.entries.push(entry);
            }
        }
    }

    for record in records.iter().filter(|r| r.kind == ProviderEventKind::Turn) {
        let outcome = match record.phase {
            ProviderEventPhase::Completed => {
                let subtype = record.provider_subtype.as_deref().unwrap_or_default();
                if subtype.starts_with("error") {
                    TurnOutcome::Failed
                } else {
                    TurnOutcome::Success
                }
            }
            ProviderEventPhase::Failed => TurnOutcome::Failed,
            ProviderEventPhase::Interrupted | ProviderEventPhase::Declined => {
                TurnOutcome::Interrupted
            }
            _ => continue,
        };
        let at = record.occurred_at_ms;
        let owner = turns
            .iter_mut()
            .rev()
            .find(|turn| turn.started_ms.is_none_or(|started| started <= at));
        if let Some(turn) = owner {
            turn.outcome = outcome;
            turn.ended_ms = Some(at);
        }
    }

    let last = turns.len();
    for turn in &mut turns {
        if turn.ended_ms.is_none() && turn.turn == last {
            turn.outcome = TurnOutcome::Running;
        }
        turn.started_at = turn.started_ms.map(rfc3339_from_ms);
        turn.ended_at = turn.ended_ms.map(rfc3339_from_ms);
    }
    turns
}

/// The slice of a transcript a caller asked for: entries at or after `since`,
/// then the last `tail` turns, each capped at `max_entries` (earliest dropped,
/// the user message kept).
pub fn select_turns(
    turns: Vec<TranscriptTurn>,
    since_ms: Option<u64>,
    tail: usize,
    max_entries: Option<usize>,
) -> Vec<TranscriptTurn> {
    let mut turns = turns
        .into_iter()
        .filter_map(|mut turn| {
            let Some(since) = since_ms else {
                return Some(turn);
            };
            if turn.ended_ms.is_some_and(|ended| ended < since) {
                return None;
            }
            turn.entries
                .retain(|entry| entry.at_ms.or(turn.started_ms).is_none_or(|at| at >= since));
            (!turn.entries.is_empty() || turn.ended_ms.is_some_and(|ended| ended >= since))
                .then_some(turn)
        })
        .collect::<Vec<_>>();
    let skip = turns.len().saturating_sub(tail);
    turns.drain(..skip);
    if let Some(max) = max_entries {
        for turn in &mut turns {
            elide_early_entries(turn, max.max(2));
        }
    }
    turns
}

fn elide_early_entries(turn: &mut TranscriptTurn, max: usize) {
    if turn.entries.len() <= max {
        return;
    }
    let keep_user = turn.entries[0].kind == EntryKind::User;
    let keep_tail = if keep_user { max - 1 } else { max };
    let start = turn.entries.len() - keep_tail;
    let first_kept = usize::from(keep_user);
    turn.elided += start - first_kept;
    turn.entries.drain(first_kept..start);
}

/// "Bash: cargo test" for the tool call the newest turn is waiting on.
pub fn current_tool(turns: &[TranscriptTurn]) -> Option<String> {
    let turn = turns.last()?;
    if turn.outcome != TurnOutcome::Running {
        return None;
    }
    turn.entries
        .iter()
        .rev()
        .find(|entry| {
            entry.kind == EntryKind::Tool && matches!(entry.status.as_str(), "running" | "pending")
        })
        .map(|entry| match (&entry.tool, entry.text.is_empty()) {
            (Some(tool), false) => format!("{tool}: {}", entry.text),
            (Some(tool), true) => tool.clone(),
            (None, _) => entry.text.clone(),
        })
}

/// The newest turn's outcome.
pub fn last_outcome(turns: &[TranscriptTurn]) -> Option<TurnOutcome> {
    turns.last().map(|turn| turn.outcome)
}

/// The most recent PR URL the chat produced or mentioned.
pub fn latest_pr_url(turns: &[TranscriptTurn]) -> Option<String> {
    turns
        .iter()
        .rev()
        .find_map(|turn| turn.pr_urls.last().cloned())
}

fn transcript_entry(
    item: &ProviderProjectionItem,
    target: Option<&str>,
    root: Option<&str>,
    options: &TranscriptOptions<'_>,
) -> Option<TranscriptEntry> {
    let status = item.status.as_str().to_owned();
    let entry = |kind, tool: Option<String>, text: String, truncated| TranscriptEntry {
        kind,
        at: None,
        tool,
        text,
        status: status.clone(),
        result: None,
        truncated,
        nested: false,
        at_ms: None,
    };
    let clip_line = |text: &str, limit| clip(&one_line(text), limit, options.full);
    let failed = matches!(
        item.status,
        ProviderProjectionStatus::Failed | ProviderProjectionStatus::Canceled
    );
    match item.render_class {
        ProjectionRenderClass::UserChat if item.body.trim().is_empty() => Some(entry(
            EntryKind::Event,
            Some("Notification".to_owned()),
            "background task update".to_owned(),
            false,
        )),
        ProjectionRenderClass::UserChat => {
            let (text, truncated) = clip_line(&item.body, USER_TEXT_LIMIT);
            Some(entry(EntryKind::User, None, text, truncated))
        }
        ProjectionRenderClass::AssistantChat => {
            let (text, truncated) = clip(item.body.trim(), ASSISTANT_TEXT_LIMIT, options.full);
            Some(entry(EntryKind::Assistant, None, text, truncated))
        }
        ProjectionRenderClass::ReasoningCard => options.include_thinking.then(|| {
            entry(
                EntryKind::Thinking,
                None,
                thinking_marker(&item.body),
                false,
            )
        }),
        ProjectionRenderClass::UsageCard => None,
        ProjectionRenderClass::HookCard if !failed => None,
        ProjectionRenderClass::StatusCard if !failed => None,
        ProjectionRenderClass::PromptCard => {
            let (text, truncated) = clip_line(
                &join_title_body(&item.title, &item.body),
                TOOL_ARG_LIMIT + TOOL_RESULT_LIMIT,
            );
            Some(entry(EntryKind::Prompt, None, text, truncated))
        }
        ProjectionRenderClass::ErrorCard
        | ProjectionRenderClass::HookCard
        | ProjectionRenderClass::StatusCard => {
            let (text, truncated) = clip_line(
                &join_title_body(&item.title, &item.body),
                TOOL_ARG_LIMIT + TOOL_RESULT_LIMIT,
            );
            Some(entry(EntryKind::Error, None, text, truncated))
        }
        ProjectionRenderClass::WarningCard
        | ProjectionRenderClass::PlanCard
        | ProjectionRenderClass::BackgroundCard => {
            let label = match item.render_class {
                ProjectionRenderClass::WarningCard => "Warning",
                ProjectionRenderClass::PlanCard => "Plan",
                _ => "Background",
            };
            let (text, truncated) = clip_line(
                &join_title_body(&item.title, &item.body),
                TOOL_ARG_LIMIT + TOOL_RESULT_LIMIT,
            );
            Some(entry(
                EntryKind::Event,
                Some(label.to_owned()),
                text,
                truncated,
            ))
        }
        _ => Some(tool_entry(item, target, root, options, status.clone())),
    }
}

fn tool_entry(
    item: &ProviderProjectionItem,
    target: Option<&str>,
    root: Option<&str>,
    options: &TranscriptOptions<'_>,
    status: String,
) -> TranscriptEntry {
    let relative = |text: &str| match root {
        Some(root) => text.replace(root, ""),
        None => text.to_owned(),
    };
    let title = one_line(&item.title);
    let (tool, arg) = match title.split_once(char::is_whitespace) {
        Some((tool, arg)) => (tool.trim_end_matches(':'), arg.trim()),
        None => (title.trim_end_matches(':'), target.unwrap_or_default()),
    };
    let body = item.body.trim();
    // A tool with no argument in its title (MCP tools) carries its input as the
    // body until a result lands; that JSON is the argument, not output.
    let input_target = (arg.is_empty() && body.starts_with('{'))
        .then(|| json_input_target(body))
        .flatten();
    let (arg, result) = if let Some(target) = input_target.as_deref() {
        (target, "")
    } else if arg.is_empty() && body.starts_with('{') {
        (body, "")
    } else if echoes_input(body, arg) {
        (arg, "")
    } else {
        (arg, body)
    };
    let tool_error = result.starts_with("<tool_use_error>");
    let result = result
        .trim_start_matches("<tool_use_error>")
        .trim_end_matches("</tool_use_error>");
    let (text, arg_clipped) = clip(&one_line(&relative(arg)), TOOL_ARG_LIMIT, options.full);
    let (result, result_clipped) = if result.trim().is_empty() {
        (None, false)
    } else {
        let (result, clipped) = clip(
            &one_line(&relative(result)),
            TOOL_RESULT_LIMIT,
            options.full,
        );
        (Some(result), clipped)
    };
    let failed = tool_error
        || matches!(
            item.status,
            ProviderProjectionStatus::Failed | ProviderProjectionStatus::Canceled
        );
    TranscriptEntry {
        kind: if failed {
            EntryKind::Error
        } else {
            EntryKind::Tool
        },
        at: None,
        tool: (!tool.is_empty()).then(|| tool.to_owned()),
        text,
        status: if tool_error {
            "failed".to_owned()
        } else {
            status
        },
        result,
        truncated: arg_clipped || result_clipped,
        nested: false,
        at_ms: None,
    }
}

/// The part of a tool's JSON input a person would name it by: the command,
/// the file, the pattern. `None` for inputs without one (most MCP tools),
/// which are shown as compact JSON instead.
fn json_input_target(body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    [
        "command",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "description",
    ]
    .iter()
    .find_map(|key| value.get(key)?.as_str())
    .map(str::trim)
    .filter(|target| !target.is_empty())
    .map(ToOwned::to_owned)
}

/// A body that is only the call's own input (`{"file_path": "<arg>"}`) says
/// nothing the argument did not.
fn echoes_input(body: &str, arg: &str) -> bool {
    if arg.is_empty() || !body.starts_with('{') {
        return false;
    }
    let Some(object) = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.as_object().cloned())
    else {
        return false;
    };
    // Shell and file tools answer in text; an object naming a command or a
    // file is the call itself (sometimes with a `cd` the agent's harness added).
    if object.contains_key("command") || object.contains_key("file_path") {
        return true;
    }
    // The title may hold only a command's first line, so compare prefixes.
    let arg = one_line(arg);
    object.values().filter_map(|v| v.as_str()).any(|v| {
        let v = one_line(v);
        !v.is_empty() && (v.starts_with(&arg) || arg.starts_with(&v))
    })
}

/// A call that opened a PR: `gh pr create`, or a tool named for creating one.
/// The evidence has to be in the call itself (its title, or its full input,
/// since a title may show only a heredoc's first line). A PR link in the
/// output alone proves nothing: `gh pr view` prints one, so does a grep hit.
fn creates_pull_request(item: &ProviderProjectionItem, full_input: Option<&str>) -> bool {
    if item.render_class == ProjectionRenderClass::UserChat
        || item.render_class == ProjectionRenderClass::AssistantChat
    {
        return false;
    }
    let names_creation = |text: &str| {
        let text = text.to_ascii_lowercase();
        text.contains("gh pr create")
            || text.contains("create_pull_request")
            || text.contains("pull_request_create")
            || text.contains("createpullrequest")
    };
    names_creation(&item.title) || full_input.is_some_and(names_creation)
}

fn join_title_body(title: &str, body: &str) -> String {
    match (title.trim(), body.trim()) {
        (title, "") => title.to_owned(),
        ("", body) => body.to_owned(),
        (title, body) => format!("{title}: {body}"),
    }
}

/// "~471 tokens" when the provider reported a size, else the text's length.
fn thinking_marker(body: &str) -> String {
    let body = body.trim();
    if let Some(start) = body.find('~') {
        let rest = &body[start..];
        if let Some(end) = rest.find("tokens") {
            return rest[..end + "tokens".len()].to_owned();
        }
    }
    format!("{} chars", body.chars().count())
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Clip to `limit` characters, marking what was dropped.
fn clip(text: &str, limit: usize, full: bool) -> (String, bool) {
    let count = text.chars().count();
    if full || count <= limit {
        return (text.to_owned(), false);
    }
    let kept = text.chars().take(limit).collect::<String>();
    (
        format!("{}...[+{} chars]", kept.trim_end(), count - limit),
        true,
    )
}

/// Pull request links (`https://<host>/<owner>/<repo>/pull/<n>`) in `text`.
pub fn find_pr_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("https://") {
        let candidate = &rest[start..];
        let end = candidate
            .find(|c: char| c.is_whitespace() || "\"'<>()[]{},`\\".contains(c))
            .unwrap_or(candidate.len());
        let url = &candidate[..end];
        if let Some(pull) = url.find("/pull/") {
            let digits = url[pull + "/pull/".len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .count();
            let path_parts = url["https://".len()..pull].split('/').count();
            if digits > 0 && path_parts == 3 {
                let url = url[..pull + "/pull/".len() + digits].to_owned();
                if !urls.contains(&url) {
                    urls.push(url);
                }
            }
        }
        rest = &candidate[end.max(1)..];
    }
    urls
}

/// `2026-09-30T08:41:52Z` for a Unix time in milliseconds.
pub fn rfc3339_from_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Milliseconds since the Unix epoch for an RFC 3339 timestamp
/// (`2026-09-30T08:41:52Z`, fractional seconds and `±HH:MM` offsets allowed).
/// Bare digits are read as Unix seconds, the store's own timestamp format.
pub fn parse_rfc3339_ms(text: &str) -> Option<u64> {
    let text = text.trim();
    if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) {
        return text.parse::<u64>().ok().map(|secs| secs * 1000);
    }
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[13] != b':' {
        return None;
    }
    if !matches!(bytes[10], b'T' | b't' | b' ') || bytes[16] != b':' {
        return None;
    }
    let num = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    let mut rest = &text[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        let padded = format!("{:0<3}", &frac[..digits.min(3)]);
        millis = padded.parse().ok()?;
        rest = &frac[digits..];
    }
    let offset_secs = match rest {
        "Z" | "z" => 0,
        _ if rest.len() == 6 && matches!(&rest[..1], "+" | "-") && &rest[3..4] == ":" => {
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            let hours = rest[1..3].parse::<i64>().ok()?;
            let minutes = rest[4..6].parse::<i64>().ok()?;
            sign * (hours * 3600 + minutes * 60)
        }
        _ => return None,
    };
    let secs = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second
        - offset_secs;
    u64::try_from(secs * 1000 + millis).ok()
}

// Howard Hinnant's civil-date algorithms (public domain).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::provider_adapters::claude_stream::parse_claude_stream_json_lines;
    use crate::provider_events::{ProviderEventContext, ProviderEventStore};

    fn records_from_claude(native: &str, base_ms: u64) -> Vec<ProviderEventRecord> {
        let temp = tempfile::tempdir().unwrap();
        store_claude_records(&temp.path().join("state.db"), None, native, base_ms)
    }

    /// Real Claude `stream-json` lines through the daemon's own path: parse,
    /// persist, read back. Line `n` occurs at `base_ms + n` seconds.
    pub(crate) fn store_claude_records(
        db_path: &Path,
        chat_thread_id: Option<i64>,
        native: &str,
        base_ms: u64,
    ) -> Vec<ProviderEventRecord> {
        let store = ProviderEventStore::new(db_path);
        let mut records = Vec::new();
        for (sequence, event) in parse_claude_stream_json_lines(native)
            .unwrap()
            .into_iter()
            .enumerate()
        {
            let mut draft = event.into_provider_event_draft(ProviderEventContext {
                workspace_id: None,
                chat_thread_id,
                process_id: None,
                occurred_at_ms: base_ms + sequence as u64 * 1000,
                schema_version: 1,
                adapter_version: "chat-transcript-test".to_owned(),
            });
            draft.provider_sequence = Some(sequence as i64);
            records.push(store.upsert_event(&draft).unwrap());
        }
        records
    }

    pub(crate) const FINISHED_TURN: &str = concat!(
        r#"{"type":"user","session_id":"s1","message":{"role":"user","content":[{"type":"text","text":"run the tests"}]}}"#,
        "\n",
        r#"{"type":"stream_event","session_id":"s1","event":{"type":"message_start","message":{"id":"m1","role":"assistant","content":[]}}}"#,
        "\n",
        r#"{"type":"stream_event","session_id":"s1","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#,
        "\n",
        r#"{"type":"stream_event","session_id":"s1","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"s up by number."}}}"#,
        "\n",
        r#"{"type":"assistant","session_id":"s1","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"s up by number."},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"cargo test --all","description":"Run tests"}}]}}"#,
        "\n",
        r#"{"type":"user","session_id":"s1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"test result: ok. 3 passed"}]}}"#,
        "\n",
        r#"{"type":"assistant","session_id":"s1","message":{"id":"m2","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"file_path":"/work/ws/crates/core/src/workspace.rs","old_string":"a","new_string":"b"}}]}}"#,
        "\n",
        r#"{"type":"user","session_id":"s1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"<tool_use_error>File has not been read yet.</tool_use_error>","is_error":true}]}}"#,
        "\n",
        r#"{"type":"assistant","session_id":"s1","message":{"id":"m3","role":"assistant","content":[{"type":"tool_use","id":"toolu_pr","name":"Bash","input":{"command":"cat > /tmp/body.md <<'EOF'\nbody\nEOF\ngh pr create --body-file /tmp/body.md"}}]}}"#,
        "\n",
        r#"{"type":"user","session_id":"s1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_pr","content":"https://github.com/perceo/archductor/pull/150\n"}]}}"#,
        "\n",
        r#"{"type":"assistant","session_id":"s1","message":{"id":"m5","role":"assistant","content":[{"type":"text","text":"Tests pass. Opened the PR; it supersedes https://github.com/perceo/archductor/pull/12."}]}}"#,
        "\n",
        r#"{"type":"result","subtype":"success","is_error":false,"session_id":"s1","result":"Tests pass.","duration_ms":1200}"#,
        "\n",
    );

    pub(crate) const MID_TOOL_CALL_TURN: &str = concat!(
        r#"{"type":"user","session_id":"s1","message":{"role":"user","content":[{"type":"text","text":"now run clippy"}]}}"#,
        "\n",
        r#"{"type":"stream_event","session_id":"s1","event":{"type":"message_start","message":{"id":"m4","role":"assistant","content":[]}}}"#,
        "\n",
        r#"{"type":"stream_event","session_id":"s1","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_3","name":"Bash","input":{}}}}"#,
        "\n",
        r#"{"type":"assistant","session_id":"s1","message":{"id":"m4","role":"assistant","content":[{"type":"tool_use","id":"toolu_3","name":"Bash","input":{"command":"cargo clippy --all-targets"}}]}}"#,
        "\n",
    );

    fn options(root: &Path) -> TranscriptOptions<'_> {
        TranscriptOptions {
            workspace_root: Some(root),
            include_thinking: true,
            full: false,
        }
    }

    #[test]
    fn a_finished_turn_reads_as_prose_tools_and_outcome_with_no_stream_deltas() {
        let records = records_from_claude(FINISHED_TURN, 1_790_757_000_000);
        let turns = build_chat_transcript(&records, &options(Path::new("/work/ws")));

        assert_eq!(turns.len(), 1, "{turns:#?}");
        let turn = &turns[0];
        assert_eq!(turn.outcome, TurnOutcome::Success);
        assert_eq!(turn.started_at.as_deref(), Some("2026-09-30T08:30:00Z"));
        assert!(turn.ended_at.is_some());
        assert_eq!(
            turn.pr_urls,
            vec!["https://github.com/perceo/archductor/pull/150".to_owned()]
        );

        assert_eq!(turn.entries[0].text, "run the tests");
        let kinds = turn.entries.iter().map(|e| e.kind).collect::<Vec<_>>();
        assert_eq!(kinds.first(), Some(&EntryKind::User));
        assert_eq!(kinds.last(), Some(&EntryKind::Assistant));
        assert!(kinds.contains(&EntryKind::Thinking));

        let bash = turn
            .entries
            .iter()
            .find(|e| e.tool.as_deref() == Some("Bash"))
            .expect("bash call");
        assert_eq!(bash.kind, EntryKind::Tool);
        assert_eq!(bash.text, "cargo test --all");
        assert_eq!(bash.result.as_deref(), Some("test result: ok. 3 passed"));

        // A tool error is an error entry, never a quiet "complete" tool line,
        // and paths are shown relative to the workspace.
        let edit = turn
            .entries
            .iter()
            .find(|e| e.tool.as_deref() == Some("Edit"))
            .expect("edit call");
        assert_eq!(edit.kind, EntryKind::Error);
        assert_eq!(edit.status, "failed");
        assert_eq!(edit.text, "crates/core/src/workspace.rs");
        assert_eq!(edit.result.as_deref(), Some("File has not been read yet."));

        // Nothing token-level leaks through: the thinking delta is a marker.
        let json = serde_json::to_string(&turns).unwrap();
        assert!(!json.contains("s up by number"), "{json}");
        assert!(!json.contains("thinking_delta"), "{json}");
        assert!(!json.contains("stream_event"), "{json}");
    }

    #[test]
    fn a_session_stopped_mid_tool_call_reports_the_running_tool() {
        let mut native = FINISHED_TURN.to_owned();
        native.push_str(MID_TOOL_CALL_TURN);
        let records = records_from_claude(&native, 1_790_757_000_000);
        let turns = build_chat_transcript(&records, &options(Path::new("/work/ws")));

        assert_eq!(turns.len(), 2, "{turns:#?}");
        assert_eq!(turns[0].outcome, TurnOutcome::Success);
        assert_eq!(turns[1].outcome, TurnOutcome::Running);
        assert_eq!(turns[1].entries[0].text, "now run clippy");
        assert_eq!(
            current_tool(&turns).as_deref(),
            Some("Bash: cargo clippy --all-targets")
        );
        assert_eq!(last_outcome(&turns), Some(TurnOutcome::Running));
        assert_eq!(
            latest_pr_url(&turns).as_deref(),
            Some("https://github.com/perceo/archductor/pull/150")
        );
        // A finished chat is not "mid call".
        assert_eq!(current_tool(&turns[..1]), None);
    }

    #[test]
    fn a_background_task_notification_mid_turn_does_not_start_a_turn() {
        let native = concat!(
            r#"{"type":"user","session_id":"s1","message":{"role":"user","content":[{"type":"text","text":"watch the build"}]}}"#,
            "\n",
            r#"{"type":"assistant","session_id":"s1","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_r","name":"Read","input":{"file_path":"/work/ws/shot.png"}}]}}"#,
            "\n",
            r#"{"type":"user","session_id":"s1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_r","content":"{\"file_path\": \"/work/ws/shot.png\"}"}]}}"#,
            "\n",
            r#"{"type":"user","session_id":"s1","isReplay":true,"message":{"role":"user","content":"<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>"}}"#,
            "\n",
            r#"{"type":"assistant","session_id":"s1","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"Build finished."}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"session_id":"s1","result":"Build finished."}"#,
            "\n",
        );
        let records = records_from_claude(native, 1_790_757_000_000);
        let turns = build_chat_transcript(&records, &options(Path::new("/work/ws")));

        assert_eq!(turns.len(), 1, "{turns:#?}");
        assert_eq!(turns[0].outcome, TurnOutcome::Success);
        assert!(turns[0]
            .entries
            .iter()
            .any(|e| e.kind == EntryKind::Event && e.tool.as_deref() == Some("Notification")));
        // A result that only repeats the input is not shown as output.
        let read = turns[0]
            .entries
            .iter()
            .find(|e| e.tool.as_deref() == Some("Read"))
            .unwrap();
        assert_eq!(read.text, "shot.png");
        assert_eq!(read.result, None);
    }

    #[test]
    fn no_thinking_drops_the_marker_and_tail_and_since_select_turns() {
        let mut native = FINISHED_TURN.to_owned();
        native.push_str(MID_TOOL_CALL_TURN);
        let records = records_from_claude(&native, 1_790_757_000_000);
        let turns = build_chat_transcript(
            &records,
            &TranscriptOptions {
                include_thinking: false,
                ..options(Path::new("/work/ws"))
            },
        );
        assert!(turns
            .iter()
            .flat_map(|t| &t.entries)
            .all(|e| e.kind != EntryKind::Thinking));

        let tail = select_turns(turns.clone(), None, 1, None);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].turn, 2);

        // Everything from the second turn's first second on.
        let since = parse_rfc3339_ms(turns[1].started_at.as_deref().unwrap()).unwrap();
        let since_turns = select_turns(turns, Some(since), 10, None);
        assert_eq!(
            since_turns.iter().map(|t| t.turn).collect::<Vec<_>>(),
            vec![2]
        );
    }

    #[test]
    fn long_text_is_clipped_with_a_visible_marker_unless_full() {
        let (clipped, truncated) = clip(&"x".repeat(130), 100, false);
        assert!(truncated);
        assert!(clipped.ends_with("...[+30 chars]"), "{clipped}");
        assert_eq!(clip(&"x".repeat(130), 100, true), ("x".repeat(130), false));
    }

    #[test]
    fn busy_turns_elide_their_earliest_steps_but_keep_the_request() {
        let entry = |kind, text: &str| TranscriptEntry {
            kind,
            at: None,
            tool: None,
            text: text.to_owned(),
            status: "complete".to_owned(),
            result: None,
            truncated: false,
            nested: false,
            at_ms: None,
        };
        let mut entries = vec![entry(EntryKind::User, "do it")];
        entries.extend((0..10).map(|n| entry(EntryKind::Tool, &n.to_string())));
        let turn = TranscriptTurn {
            turn: 1,
            started_at: None,
            ended_at: None,
            outcome: TurnOutcome::Running,
            elided: 0,
            entries,
            pr_urls: Vec::new(),
            started_ms: None,
            ended_ms: None,
        };

        let turns = select_turns(vec![turn], None, 5, Some(4));

        let texts = turns[0]
            .entries
            .iter()
            .map(|e| e.text.as_str())
            .collect::<Vec<_>>();
        assert_eq!(texts, vec!["do it", "7", "8", "9"]);
        assert_eq!(turns[0].elided, 7);
    }

    #[test]
    fn a_tool_known_only_by_its_json_input_is_named_by_its_command() {
        assert_eq!(
            json_input_target(r#"{"command": "cargo test --all", "timeout": 600000}"#).as_deref(),
            Some("cargo test --all")
        );
        assert_eq!(json_input_target(r#"{"summary": "x"}"#), None);
        assert_eq!(json_input_target("not json"), None);
        // A running call's input is not its output, even when the title only
        // carries the command's first line.
        assert!(echoes_input(
            r#"{"command": "cd /ws && cargo test\necho done", "timeout": 600000}"#,
            "cargo test"
        ));
        assert!(!echoes_input(r#"{"ok": true}"#, "cargo test"));
    }

    #[test]
    fn a_pr_url_printed_by_a_command_that_did_not_create_it_is_not_produced() {
        let native = concat!(
            r#"{"type":"user","session_id":"s1","message":{"role":"user","content":[{"type":"text","text":"is the PR up?"}]}}"#,
            "\n",
            r#"{"type":"assistant","session_id":"s1","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"toolu_v","name":"Bash","input":{"command":"gh pr view --json url -q .url"}}]}}"#,
            "\n",
            r#"{"type":"user","session_id":"s1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_v","content":"https://github.com/perceo/archductor/pull/77\n"}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"session_id":"s1","result":"yes"}"#,
            "\n",
        );
        let records = records_from_claude(native, 1_790_757_000_000);
        let turns = build_chat_transcript(&records, &options(Path::new("/work/ws")));

        assert_eq!(turns.len(), 1);
        assert!(turns[0].pr_urls.is_empty(), "{turns:#?}");
        assert_eq!(latest_pr_url(&turns), None);
    }

    #[test]
    fn pr_urls_are_found_in_prose_and_json() {
        assert_eq!(
            find_pr_urls(
                "see https://github.com/o/r/pull/12, and {\"url\":\"https://github.com/o/r/pull/12/files\"} \
                 not https://github.com/o/r/issues/3 or https://github.com/o/r/pull/"
            ),
            vec!["https://github.com/o/r/pull/12".to_owned()]
        );
    }

    #[test]
    fn rfc3339_round_trips_and_accepts_offsets_and_unix_seconds() {
        let ms = parse_rfc3339_ms("2026-09-30T08:41:52Z").unwrap();
        assert_eq!(ms, 1_790_757_712_000);
        assert_eq!(rfc3339_from_ms(ms), "2026-09-30T08:41:52Z");
        assert_eq!(
            parse_rfc3339_ms("2026-09-30T10:41:52.250+02:00"),
            Some(ms + 250)
        );
        assert_eq!(parse_rfc3339_ms("1790757712"), Some(ms));
        assert_eq!(
            parse_rfc3339_ms("2000-02-29T00:00:00Z"),
            Some(951_782_400_000)
        );
        assert_eq!(parse_rfc3339_ms("yesterday"), None);
        assert_eq!(parse_rfc3339_ms("2026-13-01T00:00:00Z"), None);
    }
}
