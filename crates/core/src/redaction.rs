pub fn redact_sensitive_text(value: &str) -> String {
    let mut redact_next = false;
    let mut output = String::new();
    for part in split_preserving_whitespace(value) {
        if part.chars().all(char::is_whitespace) {
            output.push_str(part);
            continue;
        }

        if redact_next {
            output.push_str("[redacted]");
            redact_next = false;
            continue;
        }

        if is_bearer_marker(part) {
            output.push_str(part);
            redact_next = true;
            continue;
        }

        if let Some(redacted) = redact_assignment_secret(part) {
            output.push_str(&redacted);
            continue;
        }

        if is_sensitive_key_marker(part) {
            output.push_str(part);
            redact_next = true;
            continue;
        }

        if is_flag_secret(part) {
            output.push_str(part);
            redact_next = true;
            continue;
        }

        output.push_str(part);
    }
    output
}

fn split_preserving_whitespace(value: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut in_whitespace = None;
    for (index, ch) in value.char_indices() {
        let whitespace = ch.is_whitespace();
        match in_whitespace {
            None => in_whitespace = Some(whitespace),
            Some(current) if current != whitespace => {
                parts.push(&value[start..index]);
                start = index;
                in_whitespace = Some(whitespace);
            }
            _ => {}
        }
    }
    if start < value.len() {
        parts.push(&value[start..]);
    }
    parts
}

fn redact_assignment_secret(part: &str) -> Option<String> {
    for separator in ['=', ':'] {
        let Some((key, value)) = part.split_once(separator) else {
            continue;
        };
        if !value.is_empty() && is_sensitive_key_or_flag(key) {
            return Some(format!("{key}{separator}[redacted]"));
        }
    }
    None
}

fn is_sensitive_key_marker(part: &str) -> bool {
    let marker = part
        .strip_suffix('=')
        .or_else(|| part.strip_suffix(':'))
        .unwrap_or(part);
    marker.len() != part.len() && is_sensitive_key_or_flag(marker)
}

fn is_flag_secret(part: &str) -> bool {
    part.starts_with("--") && is_sensitive_key_or_flag(part.trim_start_matches('-'))
}

fn is_bearer_marker(part: &str) -> bool {
    part.trim_matches(|ch: char| matches!(ch, '\'' | '"' | ':' | ',' | '{' | '}' | '[' | ']'))
        .eq_ignore_ascii_case("bearer")
}

fn is_sensitive_key_or_flag(key: &str) -> bool {
    let normalized = key
        .trim_matches(|ch: char| matches!(ch, '\'' | '"' | ':' | ',' | '{' | '}' | '[' | ']'))
        .trim_start_matches('-')
        .replace('-', "_")
        .to_ascii_lowercase();
    normalized == "token"
        || normalized.ends_with("_token")
        || normalized == "api_key"
        || normalized.ends_with("_api_key")
        || normalized == "key"
        || normalized.ends_with("_key")
        || normalized == "password"
        || normalized.ends_with("_password")
        || normalized == "secret"
        || normalized.ends_with("_secret")
}

#[cfg(test)]
mod tests {
    use super::redact_sensitive_text;

    #[test]
    fn redacts_common_secret_forms() {
        let redacted = redact_sensitive_text(
            "OPENAI_API_KEY=sk-secret bearer ghp_secret --password swordfish --token abc",
        );

        assert_eq!(
            redacted,
            "OPENAI_API_KEY=[redacted] bearer [redacted] --password [redacted] --token [redacted]"
        );
    }

    #[test]
    fn redacts_structured_secrets_without_collapsing_whitespace() {
        let raw = "TOKEN=abc\n\"api_key\":\"json-secret\",\npassword: yaml-secret\nsafe value\n";

        let redacted = redact_sensitive_text(raw);

        assert!(!redacted.contains("abc"));
        assert!(!redacted.contains("json-secret"));
        assert!(!redacted.contains("yaml-secret"));
        assert!(redacted.contains("TOKEN=[redacted]\n"));
        assert!(redacted.contains("\"api_key\":[redacted]\n"));
        assert!(redacted.contains("password: [redacted]\n"));
        assert!(redacted.contains("safe value\n"));
    }
}
