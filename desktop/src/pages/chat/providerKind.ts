import type { SessionKind } from "@/bridge/protocol";

/** Map a provider label to the session kind the daemon expects. */
export function providerToKind(provider: string): SessionKind {
  if (provider === "codex" || provider === "claude" || provider === "shell") return provider;
  return "codex";
}

