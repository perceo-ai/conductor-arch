import { describe, expect, it, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@/bridge/client", () => ({ send: (...args: unknown[]) => send(...args) }));
vi.mock("@/lib/log", () => ({ logAction: () => {}, logState: () => {} }));

const { providersStore } = await import("@/store/providers");
const { providerToKind } = await import("./providerKind");

const registryEntry = (provider_key: string, display_name: string) => ({
  provider_key,
  display_name,
  default_command: provider_key,
  launchable: true,
  managed: true,
  tier: "partial",
  auth_guidance: "",
});

describe("providerToKind", () => {
  beforeEach(() => {
    send.mockReset();
  });

  it("falls back to the long-standing providers before the registry loads", () => {
    expect(providerToKind("claude")).toBe("claude");
    expect(providerToKind("codex")).toBe("codex");
    expect(providerToKind("shell")).toBe("shell");
  });

  it("addresses a registered agent as itself rather than as codex", async () => {
    send.mockResolvedValue({
      type: "agent_providers",
      providers: [registryEntry("devin", "Devin CLI"), registryEntry("gemini", "Gemini CLI")],
    });
    await providersStore.load();

    expect(providerToKind("devin")).toBe("devin");
    expect(providerToKind("Devin")).toBe("devin");
    expect(providerToKind("gemini")).toBe("gemini");
    // Still nothing the daemon can launch: codex remains the default.
    expect(providerToKind("not-an-agent")).toBe("codex");
  });
});
