// Model + effort choices per provider. There is no enumeration RPC, so these
// mirror the providers archcar supports; switching a live chat sends
// set_session_model / set_session_effort. Shared by the composer (per-chat
// switching) and Settings (default-model preference).

export const MODELS: Record<string, string[]> = {
  claude: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  codex: ["gpt-5-codex", "gpt-5", "o4-mini"],
  shell: [],
};

export const EFFORTS = ["low", "medium", "high"];

/** Providers that expose switchable agent models (excludes shell/terminal). */
export const CHAT_PROVIDERS = ["codex", "claude"];

/** First model of a provider, or "" if the provider has none. */
export function firstModel(provider: string): string {
  return MODELS[provider]?.[0] ?? "";
}

/** The provider that owns a model id, or undefined if unknown. */
export function providerForModel(model: string): string | undefined {
  return Object.keys(MODELS).find((p) => MODELS[p].includes(model));
}
