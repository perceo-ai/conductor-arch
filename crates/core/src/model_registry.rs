pub const CODEX_PROVIDER: &str = "codex";
pub const CLAUDE_PROVIDER: &str = "claude";

// generated from model-corpus.json by scripts/generate-model-corpus.mjs (models)
pub const CODEX_DEFAULT_MODEL: &str = "gpt-6.1-sol";
pub const CODEX_MODEL_CHOICES: &[&str] = &[
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-astra",
    "gpt-6-luna",
];

pub const CLAUDE_DEFAULT_MODEL: &str = "claude-fable-5-1";
pub const CLAUDE_MODEL_CHOICES: &[&str] = &[
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8[1m]",
    "claude-opus-4-7[1m]",
    "claude-opus-4-6[1m]",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6[1m]",
    "claude-sonnet-4-6",
    "claude-haiku-5-5",
    "claude-haiku-4-5",
];
// end generated from model-corpus.json (models)

pub fn model_choices_for_provider(provider: &str) -> &'static [&'static str] {
    match provider {
        CODEX_PROVIDER => CODEX_MODEL_CHOICES,
        CLAUDE_PROVIDER => CLAUDE_MODEL_CHOICES,
        _ => &[],
    }
}
