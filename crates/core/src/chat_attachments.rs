use std::fs;
use std::path::Path;

use anyhow::{anyhow, Result};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentKind {
    Image,
    Text,
}

impl AttachmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Text => "text",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Image => "png",
            Self::Text => "md",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "image" => Some(Self::Image),
            "text" => Some(Self::Text),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatAttachment {
    pub path: String,
    pub label: String,
    pub kind: AttachmentKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedChatAttachment {
    pub relative_path: String,
    pub token: String,
}

pub fn format_attachment_token(attachment: &ChatAttachment) -> String {
    format!(
        "<archductor_attachment path=\"{}\" label=\"{}\" kind=\"{}\" />",
        escape_token_attr(&attachment.path),
        escape_token_attr(&attachment.label),
        attachment.kind.as_str()
    )
}

pub fn parse_attachment_token(token: &str) -> Option<ChatAttachment> {
    let trimmed = token.trim();
    let body = trimmed
        .strip_prefix("<archductor_attachment ")?
        .strip_suffix(" />")?;
    let attrs = parse_token_attrs(body)?;
    let path = attrs
        .iter()
        .find_map(|(key, value)| (key == "path").then(|| value.clone()))?;
    let label = attrs
        .iter()
        .find_map(|(key, value)| (key == "label").then(|| value.clone()))?;
    let kind = attrs
        .iter()
        .find_map(|(key, value)| (key == "kind").then_some(value.as_str()))
        .and_then(AttachmentKind::from_str)?;

    Some(ChatAttachment { path, label, kind })
}

pub fn save_chat_attachment(
    workspace_root: &Path,
    chat_id: &str,
    kind: AttachmentKind,
    label: &str,
    bytes: &[u8],
) -> Result<SavedChatAttachment> {
    let chat_id = sanitize_chat_attachment_id(chat_id)?;
    let safe_label = sanitize_attachment_label(label);
    let suffix = short_unique_suffix();
    let filename = format!("{safe_label}-{suffix}.{}", kind.extension());
    let relative_path = format!(".context/archductor/{chat_id}/{filename}");
    let target_dir = workspace_root
        .join(".context")
        .join("archductor")
        .join(&chat_id);
    let target_path = target_dir.join(&filename);

    fs::create_dir_all(&target_dir)
        .map_err(|err| anyhow!("create chat attachment directory: {err}"))?;
    fs::write(&target_path, bytes).map_err(|err| {
        anyhow!(
            "write chat attachment {}: {err}",
            target_path.to_string_lossy()
        )
    })?;

    let attachment = ChatAttachment {
        path: relative_path.clone(),
        label: label.trim().to_owned(),
        kind,
    };
    Ok(SavedChatAttachment {
        relative_path,
        token: format_attachment_token(&attachment),
    })
}

pub fn replace_long_paste_with_attachment(
    workspace_root: &Path,
    chat_id: &str,
    text: &str,
    threshold_chars: usize,
) -> Result<Option<SavedChatAttachment>> {
    if text.chars().count() <= threshold_chars {
        return Ok(None);
    }
    save_chat_attachment(
        workspace_root,
        chat_id,
        AttachmentKind::Text,
        "pasted text",
        text.as_bytes(),
    )
    .map(Some)
}

fn sanitize_chat_attachment_id(chat_id: &str) -> Result<String> {
    let trimmed = chat_id.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || !trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(anyhow!("invalid chat attachment id"));
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn sanitize_attachment_label(label: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for byte in label.bytes() {
        let next = if byte.is_ascii_alphanumeric() {
            last_dash = false;
            Some((byte as char).to_ascii_lowercase())
        } else if !last_dash {
            last_dash = true;
            Some('-')
        } else {
            None
        };
        if let Some(next) = next {
            out.push(next);
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        "pasted-content".to_owned()
    } else {
        out.to_owned()
    }
}

fn short_unique_suffix() -> String {
    Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(8)
        .collect()
}

fn escape_token_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn unescape_token_attr(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn parse_token_attrs(body: &str) -> Option<Vec<(String, String)>> {
    let mut attrs = Vec::new();
    let mut rest = body.trim();
    while !rest.is_empty() {
        let eq = rest.find('=')?;
        let key = rest[..eq].trim();
        let after_eq = rest[eq + 1..].trim_start();
        let after_quote = after_eq.strip_prefix('"')?;
        let end_quote = after_quote.find('"')?;
        let value = &after_quote[..end_quote];
        attrs.push((key.to_owned(), unescape_token_attr(value)));
        rest = after_quote[end_quote + 1..].trim_start();
    }
    Some(attrs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_parses_custom_attachment_token() {
        let attachment = ChatAttachment {
            path: ".context/archductor/42/pasted-text-a1b2c3.md".to_owned(),
            label: "pasted text".to_owned(),
            kind: AttachmentKind::Text,
        };

        let token = format_attachment_token(&attachment);

        assert_eq!(
            token,
            "<archductor_attachment path=\".context/archductor/42/pasted-text-a1b2c3.md\" label=\"pasted text\" kind=\"text\" />"
        );
        assert_eq!(parse_attachment_token(&token), Some(attachment));
    }

    #[test]
    fn saves_long_text_under_context_archductor_chat_directory() {
        let temp = tempfile::tempdir().unwrap();
        let saved = save_chat_attachment(
            temp.path(),
            "42",
            AttachmentKind::Text,
            "pasted text",
            b"hello from paste",
        )
        .unwrap();

        assert!(saved
            .relative_path
            .starts_with(".context/archductor/42/pasted-text-"));
        assert!(saved.relative_path.ends_with(".md"));
        assert_eq!(
            std::fs::read_to_string(temp.path().join(&saved.relative_path)).unwrap(),
            "hello from paste"
        );
        assert!(saved.token.contains("kind=\"text\""));
    }

    #[test]
    fn rejects_chat_ids_that_escape_context_directory() {
        let temp = tempfile::tempdir().unwrap();
        let err = save_chat_attachment(
            temp.path(),
            "../bad",
            AttachmentKind::Text,
            "pasted text",
            b"nope",
        )
        .unwrap_err();

        assert!(err.to_string().contains("invalid chat attachment id"));
    }

    #[test]
    fn replaces_only_long_text_paste_with_attachment_token() {
        let temp = tempfile::tempdir().unwrap();
        let short = replace_long_paste_with_attachment(temp.path(), "42", "short", 10).unwrap();
        assert_eq!(short, None);

        let long = replace_long_paste_with_attachment(temp.path(), "42", "01234567890", 10)
            .unwrap()
            .unwrap();
        assert!(long.token.starts_with("<archductor_attachment "));
        assert_eq!(
            std::fs::read_to_string(temp.path().join(long.relative_path)).unwrap(),
            "01234567890"
        );
    }
}
