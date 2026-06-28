#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenMessageRole {
    User,
    Agent,
}

impl ScreenMessageRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenMessage {
    pub role: ScreenMessageRole,
    pub content: String,
}

pub fn encode_send_line(line: &str) -> Vec<u8> {
    let mut encoded = line.as_bytes().to_vec();
    encoded.push(b'\r');
    encoded
}

pub fn is_trust_prompt_visible(screen: &str, trust_enabled: bool) -> bool {
    trust_enabled
        && screen.contains("Do you trust the contents of this directory?")
        && screen.contains("1. Yes, continue")
}

pub fn detect_directory_trust_prompt(screen: &str) -> bool {
    is_trust_prompt_visible(screen, true)
}

pub fn parse_codex_screen_messages(screen: &str) -> Vec<ScreenMessage> {
    let lines = screen.lines().collect::<Vec<_>>();
    let mut messages = Vec::new();
    let mut index = 0usize;

    while index < lines.len() {
        let line = lines[index];

        if let Some(role) = parse_box_role(line) {
            index += 1;
            let mut body = Vec::new();
            while index < lines.len() {
                let line = lines[index];
                if is_box_bottom(line) {
                    index += 1;
                    break;
                }
                if let Some(content) = parse_box_content(line) {
                    body.push(content);
                }
                index += 1;
            }
            push_message(&mut messages, role, body);
            continue;
        }

        if is_live_user_prompt_line(line) {
            push_live_prompt_message(&mut messages, ScreenMessageRole::User, line);
            index += 1;
            while index < lines.len() {
                if is_live_user_prompt_line(lines[index])
                    || is_live_agent_prompt_line(lines[index])
                    || is_box_header_line(lines[index])
                {
                    break;
                }
                if let Some(first_line) = parse_live_agent_bullet(lines[index]) {
                    let mut body = vec![first_line];
                    index += 1;
                    while index < lines.len() {
                        if is_live_user_prompt_line(lines[index])
                            || is_live_agent_prompt_line(lines[index])
                            || is_box_header_line(lines[index])
                        {
                            break;
                        }
                        if let Some(content) = parse_live_continuation(lines[index]) {
                            body.push(content);
                            index += 1;
                            continue;
                        }
                        if is_transient_bullet_line(lines[index]) {
                            index += 1;
                            continue;
                        }
                        break;
                    }
                    push_message(&mut messages, ScreenMessageRole::Agent, body);
                    continue;
                }
                index += 1;
            }
            continue;
        }

        if is_live_bullet_user_prompt(line, lines.get(index + 1).copied()) {
            push_live_prompt_message(&mut messages, ScreenMessageRole::User, line);
            index += 1;
            while index < lines.len() {
                if is_live_user_prompt_line(lines[index])
                    || is_live_bullet_user_prompt(lines[index], lines.get(index + 1).copied())
                    || is_box_header_line(lines[index])
                {
                    break;
                }
                if let Some(first_line) = parse_live_agent_prompt(lines[index]) {
                    let mut body = vec![first_line];
                    index += 1;
                    while index < lines.len() {
                        if is_live_user_prompt_line(lines[index])
                            || is_live_bullet_user_prompt(lines[index], lines.get(index + 1).copied())
                            || is_box_header_line(lines[index])
                        {
                            break;
                        }
                        if let Some(content) = parse_live_continuation(lines[index]) {
                            body.push(content);
                            index += 1;
                            continue;
                        }
                        break;
                    }
                    push_message(&mut messages, ScreenMessageRole::Agent, body);
                    continue;
                }
                index += 1;
            }
            continue;
        }

        index += 1;
    }

    messages
}

pub fn merge_screen_messages(existing: &mut Vec<ScreenMessage>, incoming: &[ScreenMessage]) {
    if incoming.is_empty() {
        return;
    }

    if let Some(last) = existing.last_mut() {
        let mut index = 0usize;
        while index < incoming.len() && incoming[index].role == last.role {
            if incoming[index].content == last.content {
                index += 1;
                continue;
            }
            if incoming[index].content.starts_with(&last.content) {
                last.content = incoming[index].content.clone();
                index += 1;
                continue;
            }
            break;
        }
        if index > 0 {
            append_non_overlapping(existing, &incoming[index..]);
            dedupe_adjacent(existing);
            return;
        }
    }

    let overlap = find_overlap(existing, incoming);
    if overlap > 0 {
        if let (Some(last_existing), Some(last_incoming)) =
            (existing.last_mut(), incoming.get(overlap - 1))
        {
            if last_incoming.role == last_existing.role
                && last_incoming.content.starts_with(&last_existing.content)
                && last_incoming.content.len() > last_existing.content.len()
            {
                last_existing.content = last_incoming.content.clone();
            }
        }
        existing.extend_from_slice(&incoming[overlap..]);
        dedupe_adjacent(existing);
        return;
    }

    append_non_overlapping(existing, incoming);
    dedupe_adjacent(existing);
}

fn append_non_overlapping(existing: &mut Vec<ScreenMessage>, incoming: &[ScreenMessage]) {
    let overlap = longest_overlap(existing, incoming);
    existing.extend_from_slice(&incoming[overlap..]);
}

fn longest_overlap(existing: &[ScreenMessage], incoming: &[ScreenMessage]) -> usize {
    let max_overlap = existing.len().min(incoming.len());
    for overlap in (1..=max_overlap).rev() {
        if existing[existing.len() - overlap..] == incoming[..overlap] {
            return overlap;
        }
    }
    0
}

fn find_overlap(existing: &[ScreenMessage], incoming: &[ScreenMessage]) -> usize {
    let max_overlap = existing.len().min(incoming.len());
    for overlap in (1..=max_overlap).rev() {
        let existing_slice = &existing[existing.len() - overlap..];
        let incoming_slice = &incoming[..overlap];
        if slices_overlap(existing_slice, incoming_slice) {
            return overlap;
        }
    }
    0
}

fn slices_overlap(existing: &[ScreenMessage], incoming: &[ScreenMessage]) -> bool {
    for index in 0..existing.len() {
        if existing[index].role != incoming[index].role {
            return false;
        }
        if index + 1 == existing.len() {
            if incoming[index].content == existing[index].content {
                continue;
            }
            if incoming[index].content.starts_with(&existing[index].content) {
                continue;
            }
            return false;
        }
        if existing[index].content != incoming[index].content {
            return false;
        }
    }
    true
}

fn dedupe_adjacent(messages: &mut Vec<ScreenMessage>) {
    messages.dedup_by(|right, left| left == right);
}

fn parse_box_role(line: &str) -> Option<ScreenMessageRole> {
    if !is_box_header_line(line) {
        return None;
    }
    let lower = line.to_ascii_lowercase();
    if lower.contains("you") || lower.contains("user") {
        return Some(ScreenMessageRole::User);
    }
    if lower.contains("codex") || lower.contains("assistant") || lower.contains("agent") {
        return Some(ScreenMessageRole::Agent);
    }
    None
}

fn is_box_header_line(line: &str) -> bool {
    line.trim_start().starts_with('╭')
}

fn is_box_bottom(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('╰') || trimmed.starts_with('└')
}

fn parse_box_content(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let border = trimmed.chars().next()?;
    if border != '│' && border != '┃' {
        return None;
    }
    let content = trimmed[border.len_utf8()..].trim_start();
    let content = content.trim_end();
    let content = content
        .strip_suffix('│')
        .or_else(|| content.strip_suffix('┃'))
        .unwrap_or(content)
        .trim_end();
    Some(content.to_owned())
}

fn is_live_user_prompt_line(line: &str) -> bool {
    line.trim_start().starts_with('›')
}

fn is_live_agent_prompt_line(line: &str) -> bool {
    line.trim_start().starts_with('>')
}

fn is_live_bullet_user_prompt(line: &str, next_line: Option<&str>) -> bool {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('•') {
        return false;
    }
    next_line
        .map(|line| line.trim_start().starts_with('>'))
        .unwrap_or(false)
}

fn parse_live_prompt_content(line: &str) -> String {
    let trimmed = line.trim_start();
    for marker in ['›', '•', '>'] {
        if let Some(content) = trimmed.strip_prefix(marker) {
            return content.trim_start().to_owned();
        }
    }
    String::new()
}

fn push_live_prompt_message(
    messages: &mut Vec<ScreenMessage>,
    role: ScreenMessageRole,
    line: &str,
) {
    let content = parse_live_prompt_content(line);
    if !content.is_empty() {
        messages.push(ScreenMessage { role, content });
    }
}

fn parse_live_agent_prompt(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let content = trimmed.strip_prefix('>')?.trim_start();
    Some(content.to_owned())
}

fn parse_live_agent_bullet(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let bullet = trimmed.strip_prefix('•')?.trim_start();
    if is_transient_status_bullet(bullet) {
        return None;
    }
    Some(bullet.to_owned())
}

fn parse_live_continuation(line: &str) -> Option<String> {
    if line.trim().is_empty() {
        return None;
    }
    let trimmed_end = line.trim_end();
    if !(trimmed_end.starts_with(' ') || trimmed_end.starts_with('\t')) {
        return None;
    }
    let trimmed = trimmed_end.trim_start();
    if let Some(bullet) = trimmed.strip_prefix('•') {
        let bullet = bullet.trim_start();
        if is_transient_status_bullet(bullet) {
            return None;
        }
        return Some(bullet.to_owned());
    }
    Some(trimmed.to_owned())
}

fn is_transient_bullet_line(line: &str) -> bool {
    line.trim_start()
        .strip_prefix('•')
        .map(|content| is_transient_status_bullet(content.trim_start()))
        .unwrap_or(false)
}

fn is_transient_status_bullet(content: &str) -> bool {
    content.starts_with("Starting MCP servers")
        || content.starts_with("Working (")
        || content.starts_with("Thinking (")
}

fn push_message(messages: &mut Vec<ScreenMessage>, role: ScreenMessageRole, body: Vec<String>) {
    let content = trim_blank_edges(&body.join("\n"));
    if content.is_empty() {
        return;
    }
    messages.push(ScreenMessage { role, content });
}

fn trim_blank_edges(content: &str) -> String {
    let lines = content.lines().collect::<Vec<_>>();
    let start = lines
        .iter()
        .position(|line| !line.trim().is_empty())
        .unwrap_or(lines.len());
    let end = lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .map(|index| index + 1)
        .unwrap_or(start);
    lines[start..end].join("\n")
}

#[cfg(test)]
mod tests {
    use super::{
        detect_directory_trust_prompt, encode_send_line, is_trust_prompt_visible,
        merge_screen_messages, parse_codex_screen_messages, ScreenMessage, ScreenMessageRole,
    };

    #[test]
    fn encode_send_line_returns_line_bytes_plus_carriage_return() {
        assert_eq!(encode_send_line("status"), b"status\r");
    }

    #[test]
    fn trust_prompt_detection_requires_both_strings_and_can_be_gated_externally() {
        let full_prompt = "\
Do you trust the contents of this directory?
1. Yes, continue";

        assert!(detect_directory_trust_prompt(full_prompt));
        assert!(is_trust_prompt_visible(full_prompt, true));
        assert!(!is_trust_prompt_visible(
            "Do you trust the contents of this directory?",
            true
        ));
        assert!(!is_trust_prompt_visible("1. Yes, continue", true));
        assert!(!is_trust_prompt_visible(full_prompt, false));
    }

    #[test]
    fn parses_boxed_you_and_codex_messages() {
        let screen = "\
╭─ You ─────────────────╮
│ Summarize the test.   │
╰───────────────────────╯
╭─ Codex ───────────────╮
│ Ready.                │
┃ Running checks now.   │
└───────────────────────╯";

        assert_eq!(
            parse_codex_screen_messages(screen),
            vec![
                ScreenMessage {
                    role: ScreenMessageRole::User,
                    content: "Summarize the test.".to_owned(),
                },
                ScreenMessage {
                    role: ScreenMessageRole::Agent,
                    content: "Ready.\nRunning checks now.".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn parses_boxed_codex_bullet_content() {
        let screen = "\
╭─ Assistant ───────────╮
│ • Inspect the repo    │
│ • Run the tests       │
╰───────────────────────╯";

        assert_eq!(
            parse_codex_screen_messages(screen),
            vec![ScreenMessage {
                role: ScreenMessageRole::Agent,
                content: "• Inspect the repo\n• Run the tests".to_owned(),
            }]
        );
    }

    #[test]
    fn parses_headerless_live_tui_bullet_responses_after_prompt() {
        let screen = "\
› User prompt
• Fix auth callback
  continuation line";

        assert_eq!(
            parse_codex_screen_messages(screen),
            vec![
                ScreenMessage {
                    role: ScreenMessageRole::User,
                    content: "User prompt".to_owned(),
                },
                ScreenMessage {
                    role: ScreenMessageRole::Agent,
                    content: "Fix auth callback\ncontinuation line".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn ignores_transient_status_bullets() {
        let screen = "\
› User prompt
• Starting MCP servers
• Working (4s)
• Search complete";

        assert_eq!(
            parse_codex_screen_messages(screen),
            vec![
                ScreenMessage {
                    role: ScreenMessageRole::User,
                    content: "User prompt".to_owned(),
                },
                ScreenMessage {
                    role: ScreenMessageRole::Agent,
                    content: "Search complete".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn parses_live_tui_when_user_is_bullet_and_agent_is_gt_marker() {
        let screen = "\
• user prompt
> first agent line
  continuation line";

        assert_eq!(
            parse_codex_screen_messages(screen),
            vec![
                ScreenMessage {
                    role: ScreenMessageRole::User,
                    content: "user prompt".to_owned(),
                },
                ScreenMessage {
                    role: ScreenMessageRole::Agent,
                    content: "first agent line\ncontinuation line".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn dedupes_and_merges_repainted_messages_when_same_role_prefix_is_extended() {
        let mut existing = vec![ScreenMessage {
            role: ScreenMessageRole::Agent,
            content: "Inspect".to_owned(),
        }];
        let incoming = vec![
            ScreenMessage {
                role: ScreenMessageRole::Agent,
                content: "Inspect".to_owned(),
            },
            ScreenMessage {
                role: ScreenMessageRole::Agent,
                content: "Inspect the repo".to_owned(),
            },
            ScreenMessage {
                role: ScreenMessageRole::User,
                content: "continue".to_owned(),
            },
        ];

        merge_screen_messages(&mut existing, &incoming);

        assert_eq!(
            existing,
            vec![
                ScreenMessage {
                    role: ScreenMessageRole::Agent,
                    content: "Inspect the repo".to_owned(),
                },
                ScreenMessage {
                    role: ScreenMessageRole::User,
                    content: "continue".to_owned(),
                },
            ]
        );
    }
}
