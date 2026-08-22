import { createSignal } from "solid-js";

import { send } from "@/bridge/client";
import { logAction, logState } from "@/lib/log";
import type { AgentProviderSummary } from "@/bridge/protocol";

// The daemon's agent registry. Provider pickers render from this rather than a
// hardcoded list, so an agent added to the registry appears in the UI without a
// renderer change — and, just as important, an agent this build cannot drive
// does not appear as though it can.
//
// The daemon is the authority here: under a remote profile the answer describes
// the server's registry, not this machine's.

const [providers, setProviders] = createSignal<AgentProviderSummary[]>([]);
const [loaded, setLoaded] = createSignal(false);

async function load(): Promise<AgentProviderSummary[]> {
  logAction("agent providers load");
  const res = await send({ type: "list_agent_providers" });
  if (res.type === "error") throw new Error(res.message);
  if (res.type !== "agent_providers") {
    throw new Error(`unexpected response ${res.type}`);
  }
  setProviders(res.providers);
  setLoaded(true);
  logState("agent providers", {
    count: res.providers.length,
    launchable: res.providers.filter((provider) => provider.launchable).length,
  });
  return res.providers;
}

export const providersStore = {
  providers,
  loaded,
  load,
  /** Agents that can back a chat session. Empty until the first load resolves. */
  launchable: () => providers().filter((provider) => provider.launchable),
  byKey: (key: string) => providers().find((provider) => provider.provider_key === key),
  /**
   * Tier badge text, or null when there is nothing worth saying. Full-tier
   * providers get no badge — they are the baseline, and labelling them would
   * add noise to the common case.
   */
  tierBadge: (key: string): string | null => {
    const provider = providers().find((entry) => entry.provider_key === key);
    if (!provider || !provider.launchable) return null;
    if (provider.tier === "full") return null;
    if (provider.tier === "partial") return "limited";
    return "basic";
  },
};
