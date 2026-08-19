pub const CODEX_PROVIDER: &str = "codex";
pub const CLAUDE_PROVIDER: &str = "claude";

pub const CODEX_DEFAULT_MODEL: &str = "gpt-5.6-sol";
pub const CODEX_MODEL_CHOICES: &[&str] = &[
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
];

pub const CLAUDE_MODEL_CHOICES: &[&str] = &[
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8[1m]",
    "claude-opus-4-7[1m]",
    "claude-opus-4-6[1m]",
    "claude-sonnet-5",
    "claude-sonnet-4-6[1m]",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
];

pub fn model_choices_for_provider(provider: &str) -> &'static [&'static str] {
    match provider {
        CODEX_PROVIDER => CODEX_MODEL_CHOICES,
        CLAUDE_PROVIDER => CLAUDE_MODEL_CHOICES,
        _ => &[],
    }
}
