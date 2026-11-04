import type { SessionKind } from "@/bridge/protocol";
import { providersStore } from "@/store/providers";

/**
 * Map a provider label to the session kind the daemon expects.
 *
 * Any agent the daemon's registry knows is passed through unchanged, so a
 * newly registered agent is addressed as itself. Falling back to codex for an
 * unknown label is deliberate: it is the default chat provider, and sending a
 * label the daemon cannot launch would fail the RPC instead.
 */
export function providerToKind(provider: string): SessionKind {
  const key = provider.trim().toLowerCase();
  if (key === "shell") return "shell";
  if (providersStore.byKey(key)) return key;
  // Before the registry has loaded, the two long-standing providers are still
  // recognised by name.
  if (key.includes("claude")) return "claude";
  if (key.includes("codex")) return "codex";
  return "codex";
}
