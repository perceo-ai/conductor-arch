pub const CODEX_PROVIDER: &str = "codex";
pub const CLAUDE_PROVIDER: &str = "claude";

pub const CODEX_DEFAULT_MODEL: &str = "gpt-5.5";
pub const CODEX_MODEL_CHOICES: &[&str] =
    &["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"];

pub const CLAUDE_MODEL_CHOICES: &[&str] = &[
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
];

pub fn model_choices_for_provider(provider: &str) -> &'static [&'static str] {
    match provider {
        CODEX_PROVIDER => CODEX_MODEL_CHOICES,
        CLAUDE_PROVIDER => CLAUDE_MODEL_CHOICES,
        _ => &[],
    }
}
