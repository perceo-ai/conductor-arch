// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// prefs drives the default model new chats start on. Runs in the node env where
// localStorage is absent, so this also exercises the no-localStorage fallback.

describe("prefsStore", () => {
  beforeEach(() => vi.resetModules());

  it("defaults to a concrete codex model", async () => {
    const { prefsStore } = await import("./prefs");
    expect(prefsStore.state.defaultProvider).toBe("codex");
    expect(prefsStore.state.defaultModel).toBe("gpt-5-codex");
  });

  it("derives the provider when the default model changes", async () => {
    const { prefsStore } = await import("./prefs");
    prefsStore.setDefaultModel("claude-opus-4-8");
    expect(prefsStore.state.defaultProvider).toBe("claude");
    expect(prefsStore.state.defaultModel).toBe("claude-opus-4-8");
  });

  it("seeds the default model for its own provider, first model otherwise", async () => {
    const { prefsStore } = await import("./prefs");
    prefsStore.setDefaultModel("claude-sonnet-4-6");
    // Same provider as the default → use the exact default model.
    expect(prefsStore.seedModelFor("claude")).toBe("claude-sonnet-4-6");
    // Different provider → fall back to that provider's first model.
    expect(prefsStore.seedModelFor("codex")).toBe("gpt-5-codex");
  });
});
