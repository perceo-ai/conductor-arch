// Model + effort choices per provider. There is no enumeration RPC, so these
// mirror the providers archcar supports; switching a live chat sends
// set_session_model / set_session_effort. Shared by the composer (per-chat
// switching) and Settings (default-model preference).

// generated from model-corpus.json by scripts/generate-model-corpus.mjs (models)
export const MODELS: Record<string, string[]> = {
  codex: [
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-astra",
    "gpt-6-luna",
  ],
  claude: [
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
  ],
  shell: [],
};
// end generated from model-corpus.json (models)

export const EFFORTS = ["low", "medium", "high"];

/**
 * Fallback chat providers, used only before the daemon's registry arrives.
 * Live values come from ListAgentProviders — see providersStore.
 */
export const CHAT_PROVIDERS = ["codex", "claude"];

const PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
};

/**
 * Prefers the daemon's display name; `known` is the registry snapshot when one
 * has loaded. Falls back to the raw key so an unknown provider still renders.
 */
export function providerLabel(
  provider: string,
  known?: { provider_key: string; display_name: string }[],
): string {
  const match = known?.find((entry) => entry.provider_key === provider);
  if (match) return match.display_name;
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * The canonical label. The daemon's `model_label` and iOS `AgentModels.label`
 * mirror it, and all three assert crates/core/tests/fixtures/model_labels.json.
 */
export function modelLabel(model: string): string {
  // generated from model-corpus.json by scripts/generate-model-corpus.mjs (labels)
  if (model === "claude-fable-5-1") return "Claude Fable 5.1";
  if (model === "claude-opus-5-5") return "Claude Opus 5.5";
  if (model === "claude-opus-4-8[1m]") return "Claude Opus 4.8 1M";
  if (model === "claude-opus-4-7[1m]") return "Claude Opus 4.7 1M";
  if (model === "claude-opus-4-6[1m]") return "Claude Opus 4.6 1M";
  if (model === "claude-sonnet-5-5") return "Claude Sonnet 5.5";
  if (model === "claude-sonnet-5") return "Claude Sonnet 5 1M";
  if (model === "claude-sonnet-4-6[1m]") return "Claude Sonnet 4.6 1M";
  if (model === "claude-sonnet-4-6") return "Claude Sonnet 4.6";
  if (model === "claude-haiku-5-5") return "Claude Haiku 5.5";
  if (model === "claude-haiku-4-5") return "Claude Haiku 4.5";
  // end generated from model-corpus.json (labels)
  const longContext = model.endsWith("[1m]");
  const base = longContext ? model.slice(0, -"[1m]".length) : model;
  const parts = base
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) =>
      part.toLowerCase() === "gpt" ? "GPT" : part[0]?.toUpperCase() + part.slice(1),
    );
  if (longContext) parts.push("1M");
  return parts.join(" ");
}

export interface AgentModelOption {
  provider: string;
  model: string;
  value: string;
  label: string;
  group: string;
}

export function agentModelValue(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export function agentModelOptions(): AgentModelOption[] {
  return CHAT_PROVIDERS.flatMap((provider) =>
    (MODELS[provider] ?? []).map((model) => ({
      provider,
      model,
      value: agentModelValue(provider, model),
      label: modelLabel(model),
      group: providerLabel(provider),
    })),
  );
}

/** First model of a provider, or "" if the provider has none. */
export function firstModel(provider: string): string {
  return MODELS[provider]?.[0] ?? "";
}

/** The provider that owns a model id, or undefined if unknown. */
export function providerForModel(model: string): string | undefined {
  return Object.keys(MODELS).find((p) => MODELS[p].includes(model));
}
