import { describe, expect, it, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@/bridge/client", () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock("@/lib/log", () => ({ logAction: () => {}, logState: () => {} }));

const { providersStore } = await import("./providers");

const REGISTRY = [
  {
    provider_key: "codex",
    display_name: "Codex",
    default_command: "codex",
    launchable: true,
    managed: true,
    tier: "full",
    auth_guidance: "Run `codex login`.",
  },
  {
    provider_key: "gemini",
    display_name: "Gemini CLI",
    default_command: "gemini",
    launchable: true,
    managed: true,
    tier: "partial",
    auth_guidance: "Run `gemini` once to sign in.",
  },
  {
    provider_key: "aider",
    display_name: "Aider",
    default_command: "aider",
    launchable: false,
    managed: false,
    tier: "none",
    auth_guidance: "Install Aider.",
  },
];

describe("providersStore", () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({ type: "agent_providers", providers: REGISTRY });
  });

  it("loads the daemon registry rather than a hardcoded list", async () => {
    await providersStore.load();

    expect(send).toHaveBeenCalledWith({ type: "list_agent_providers" });
    expect(providersStore.providers()).toHaveLength(3);
    expect(providersStore.loaded()).toBe(true);
  });

  it("offers only agents this build can actually drive", async () => {
    await providersStore.load();

    // Aider is detected but has no adapter, so presenting it as a chat provider
    // would promise a session that cannot start.
    expect(providersStore.launchable().map((p) => p.provider_key)).toEqual(["codex", "gemini"]);
  });

  it("badges reduced support and stays quiet about the baseline", async () => {
    await providersStore.load();

    // Full tier is the common case; a badge there would be noise.
    expect(providersStore.tierBadge("codex")).toBeNull();
    expect(providersStore.tierBadge("gemini")).toBe("limited");
    // Nothing to say about a provider that is not offered at all.
    expect(providersStore.tierBadge("aider")).toBeNull();
    expect(providersStore.tierBadge("nonexistent")).toBeNull();
  });

  it("surfaces a daemon error instead of silently showing no providers", async () => {
    send.mockResolvedValue({ type: "error", message: "daemon unavailable" });

    await expect(providersStore.load()).rejects.toThrow("daemon unavailable");
  });

  it("rejects an unexpected response rather than mis-rendering it", async () => {
    send.mockResolvedValue({ type: "prompt_packs", repository: "demo", packs: [] });

    await expect(providersStore.load()).rejects.toThrow("unexpected response");
  });
});
