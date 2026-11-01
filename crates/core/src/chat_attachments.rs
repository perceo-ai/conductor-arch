use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use anyhow::{anyhow, Result};
use uuid::Uuid;

pub const MAX_CHAT_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
const MAX_ATTACHMENT_STEM_BYTES: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentKind {
    File,
    Image,
    Text,
}

impl AttachmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Image => "image",
            Self::Text => "text",
        }
    }

    fn fallback_extension(self) -> &'static str {
        match self {
            Self::File => "bin",
            Self::Image => "png",
            Self::Text => "md",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "file" => Some(Self::File),
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
    if bytes.len() > MAX_CHAT_ATTACHMENT_BYTES {
        return Err(anyhow!("chat attachment is larger than 25 MiB"));
    }
    let chat_id = sanitize_chat_attachment_id(chat_id)?;
    let extension = attachment_extension(kind, label);
    let safe_label = sanitize_attachment_stem(label);
    let suffix = short_unique_suffix();
    let filename = format!("{safe_label}-{suffix}.{extension}");
    let relative_path = format!(".context/archductor/{chat_id}/{filename}");
    let context_dir = workspace_root.join(".context");
    let archductor_dir = context_dir.join("archductor");
    let target_dir = archductor_dir.join(&chat_id);
    let target_path = target_dir.join(&filename);

    reject_symlink(&context_dir)?;
    reject_symlink(&archductor_dir)?;
    reject_symlink(&target_dir)?;
    fs::create_dir_all(&target_dir)
        .map_err(|err| anyhow!("create chat attachment directory: {err}"))?;
    reject_symlink(&context_dir)?;
    reject_symlink(&archductor_dir)?;
    reject_symlink(&target_dir)?;
    let mut target = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target_path)
        .map_err(|err| anyhow!("create chat attachment {}: {err}", target_path.display()))?;
    target.write_all(bytes).map_err(|err| {
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

fn sanitize_attachment_stem(label: &str) -> String {
    let file_name = label.rsplit(['/', '\\']).next().unwrap_or(label).trim();
    let stem = file_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file_name);
    let mut out = String::new();
    let mut last_dash = false;
    for byte in stem.bytes() {
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
            if out.len() == MAX_ATTACHMENT_STEM_BYTES {
                break;
            }
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        "pasted-content".to_owned()
    } else {
        out.to_owned()
    }
}

fn reject_symlink(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(anyhow!(
            "chat attachment path contains a symlink: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(anyhow!(
            "inspect chat attachment path {}: {err}",
            path.display()
        )),
    }
}

fn attachment_extension(kind: AttachmentKind, label: &str) -> String {
    if kind == AttachmentKind::Text {
        return kind.fallback_extension().to_owned();
    }
    let ext = label
        .rsplit(['/', '\\'])
        .next()
        .and_then(|file_name| file_name.rsplit_once('.').map(|(_, ext)| ext))
        .map(|ext| ext.trim().to_ascii_lowercase())
        .filter(|ext| {
            !ext.is_empty()
                && ext.len() <= 16
                && ext
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-'))
        });
    ext.unwrap_or_else(|| kind.fallback_extension().to_owned())
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
    fn saves_binary_file_with_safe_original_extension() {
        let temp = tempfile::tempdir().unwrap();
        let saved = save_chat_attachment(
            temp.path(),
            "42",
            AttachmentKind::File,
            "../Screen Shot 1.PDF",
            b"%PDF",
        )
        .unwrap();

        assert!(saved
            .relative_path
            .starts_with(".context/archductor/42/screen-shot-1-"));
        assert!(saved.relative_path.ends_with(".pdf"));
        assert_eq!(
            std::fs::read(temp.path().join(&saved.relative_path)).unwrap(),
            b"%PDF"
        );
        assert!(saved.token.contains("kind=\"file\""));
    }

    #[test]
    fn rejects_attachment_larger_than_transport_limit() {
        let temp = tempfile::tempdir().unwrap();
        let bytes = vec![0_u8; 25 * 1024 * 1024 + 1];

        let err = save_chat_attachment(temp.path(), "42", AttachmentKind::File, "huge.zip", &bytes)
            .unwrap_err();

        assert!(err.to_string().contains("25 MiB"), "{err:#}");
    }

    #[test]
    fn bounds_generated_filename_length() {
        let temp = tempfile::tempdir().unwrap();
        let label = format!("{}.txt", "a".repeat(250));
        let saved =
            save_chat_attachment(temp.path(), "42", AttachmentKind::File, &label, b"content")
                .unwrap();
        let filename = saved.relative_path.rsplit('/').next().unwrap();

        assert!(filename.len() <= 255, "{} bytes", filename.len());
        assert_eq!(
            fs::read(temp.path().join(saved.relative_path)).unwrap(),
            b"content"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_attachment_directory() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join(".context")).unwrap();
        symlink(outside.path(), temp.path().join(".context/archductor")).unwrap();

        let err = save_chat_attachment(
            temp.path(),
            "42",
            AttachmentKind::File,
            "secret.txt",
            b"do not escape",
        )
        .unwrap_err();

        assert!(err.to_string().contains("symlink"), "{err:#}");
        assert!(!outside.path().join("42").exists());
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
