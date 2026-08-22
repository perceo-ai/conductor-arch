// Model + effort choices per provider. There is no enumeration RPC, so these
// mirror the providers archcar supports; switching a live chat sends
// set_session_model / set_session_effort. Shared by the composer (per-chat
// switching) and Settings (default-model preference).

export const MODELS: Record<string, string[]> = {
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
  claude: [
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8[1m]",
    "claude-opus-4-7[1m]",
    "claude-opus-4-6[1m]",
    "claude-sonnet-5",
    "claude-sonnet-4-6[1m]",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
  shell: [],
};

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

export function modelLabel(model: string): string {
  if (model === "gpt-5.6-sol") return "GPT 5.6 Sol";
  if (model === "gpt-5.6-terra") return "GPT 5.6 Terra";
  if (model === "gpt-5.6-luna") return "GPT 5.6 Luna";
  if (model === "gpt-5.5") return "GPT 5.5";
  if (model === "gpt-5.4") return "GPT 5.4";
  if (model === "claude-opus-4-8[1m]") return "Claude Opus 4.8 1M";
  if (model === "claude-opus-4-7[1m]") return "Claude Opus 4.7 1M";
  if (model === "claude-opus-4-6[1m]") return "Claude Opus 4.6 1M";
  if (model === "claude-sonnet-5") return "Claude Sonnet 5 1M";
  if (model === "claude-sonnet-4-6[1m]") return "Claude Sonnet 4.6 1M";
  if (model === "claude-sonnet-4-6") return "Claude Sonnet 4.6";
  if (model === "claude-haiku-4-5") return "Claude Haiku 4.5";
  return model
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
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
