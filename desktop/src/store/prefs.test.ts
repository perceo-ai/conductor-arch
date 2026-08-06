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

  it("defaults appearance to dark / amber / cozy", async () => {
    const { prefsStore } = await import("./prefs");
    expect(prefsStore.state.theme).toBe("dark");
    expect(prefsStore.state.accent).toBe("amber");
    expect(prefsStore.state.density).toBe("cozy");
  });

  it("updates appearance prefs through their setters", async () => {
    const { prefsStore } = await import("./prefs");
    prefsStore.setTheme("light");
    prefsStore.setAccent("blue");
    prefsStore.setDensity("compact");
    expect(prefsStore.state.theme).toBe("light");
    expect(prefsStore.state.accent).toBe("blue");
    expect(prefsStore.state.density).toBe("compact");
  });

  it("exposes a hex for every accent", async () => {
    const { ACCENT_HEX } = await import("./prefs");
    expect(ACCENT_HEX.amber).toMatch(/^#[0-9a-f]{6}$/i);
    expect(Object.keys(ACCENT_HEX)).toEqual(["amber", "blue", "green", "rose"]);
  });
});
