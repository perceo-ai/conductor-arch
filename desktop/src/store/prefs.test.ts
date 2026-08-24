// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// prefs drives the default model new chats start on. Runs in the node env where
// localStorage is absent, so this also exercises the no-localStorage fallback.

describe("prefsStore", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to a concrete codex model", async () => {
    const { prefsStore } = await import("./prefs");
    expect(prefsStore.state.defaultProvider).toBe("codex");
    expect(prefsStore.state.defaultModel).toBe("gpt-5.6-sol");
  });

  it("derives the provider when the default model changes", async () => {
    const { prefsStore } = await import("./prefs");
    prefsStore.setDefaultModel("claude-opus-5");
    expect(prefsStore.state.defaultProvider).toBe("claude");
    expect(prefsStore.state.defaultModel).toBe("claude-opus-5");
  });

  it("seeds the default model for its own provider, first model otherwise", async () => {
    const { prefsStore } = await import("./prefs");
    prefsStore.setDefaultModel("claude-sonnet-5");
    // Same provider as the default → use the exact default model.
    expect(prefsStore.seedModelFor("claude")).toBe("claude-sonnet-5");
    // Different provider → fall back to that provider's first model.
    expect(prefsStore.seedModelFor("codex")).toBe("gpt-5.6-sol");
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

  it("tracks the sidebar-collapsed layout flag", async () => {
    const { prefsStore } = await import("./prefs");
    expect(prefsStore.state.sidebarCollapsed).toBe(false);
    prefsStore.setSidebarCollapsed(true);
    expect(prefsStore.state.sidebarCollapsed).toBe(true);
  });

  it("defaults device-local layout preferences", async () => {
    const { prefsStore } = await import("./prefs");
    expect(prefsStore.state.activePresetId).toBe("code");
    expect(prefsStore.state.regionSizes).toEqual({ left: 260, center: 0, right: 300, bottom: 280 });
    expect(prefsStore.state.collapsedRegions).toEqual([]);
    prefsStore.setActivePresetId("wide");
    prefsStore.setRegionSize("bottom", 320);
    prefsStore.setCollapsedRegions(["left"]);
    expect(prefsStore.state.activePresetId).toBe("wide");
    expect(prefsStore.state.regionSizes.bottom).toBe(320);
    expect(prefsStore.state.collapsedRegions).toEqual(["left"]);
  });

  it("migrates legacy panel dimensions while retaining sidebar and terminal preferences", async () => {
    const values = new Map<string, string>([
      ["archductor.prefs.v1", JSON.stringify({ sidebarCollapsed: true })],
      ["rightPanel.width", "333"],
      ["terminalDock.height", "444"],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const { prefsStore } = await import("./prefs");
    expect(prefsStore.state.sidebarCollapsed).toBe(true);
    expect(prefsStore.state.regionSizes.right).toBe(333);
    expect(prefsStore.state.regionSizes.bottom).toBe(444);
    expect(values.has("rightPanel.width")).toBe(false);
    expect(values.get("terminalDock.height")).toBe("444");
    expect(JSON.parse(values.get("archductor.prefs.v1")!).regionSizes).toMatchObject({ right: 333, bottom: 444 });
    prefsStore.setRegionSize("bottom", 320);
    vi.resetModules();
    const { prefsStore: reloadedPrefs } = await import("./prefs");
    expect(reloadedPrefs.state.regionSizes.bottom).toBe(320);
  });

  it("tracks custom keyboard bindings", async () => {
    const { prefsStore } = await import("./prefs");
    expect(prefsStore.state.keybindings).toBe("");
    prefsStore.setKeybindings("palette=ctrl+p; focus=ctrl+shift+f");
    expect(prefsStore.state.keybindings).toBe("palette=ctrl+p; focus=ctrl+shift+f");
  });

  it("exposes a hex for every accent", async () => {
    const { ACCENT_HEX } = await import("./prefs");
    expect(ACCENT_HEX.amber).toMatch(/^#[0-9a-f]{6}$/i);
    expect(Object.keys(ACCENT_HEX)).toEqual(["amber", "blue", "green", "rose"]);
  });
});
