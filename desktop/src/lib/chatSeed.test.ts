// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { firstModel } from "./models";
import { seedForSelectedThread } from "./chatSeed";

// A brand-new workspace's first chat is created by the backend with no model,
// then selected (not created) by ChatSurface. Selecting it must seed the
// user's default model so the composer opens on it, not the provider's first.

/** What the composer opens on: seed, then the thread's own model, then the
 *  provider's first model (Composer's last-resort fallback). */
function composerModel(
  thread: { id: number; provider: string; model: string | null },
  pending: Record<number, string>,
) {
  return pending[thread.id] || thread.model || firstModel(thread.provider);
}

describe("seedForSelectedThread", () => {
  beforeEach(() => vi.resetModules());

  it("seeds a model-less first chat with the configured default model", async () => {
    const { prefsStore } = await import("@/store/prefs");
    prefsStore.setDefaultModel("claude-opus-5");
    const thread = { id: 1, provider: "claude", model: null };

    const seed = seedForSelectedThread(thread, {}, prefsStore.seedModelFor);
    const pending = seed ? { [thread.id]: seed } : {};

    expect(seed).toBe("claude-opus-5");
    expect(composerModel(thread, pending)).toBe("claude-opus-5");
    expect(composerModel(thread, pending)).not.toBe(firstModel("claude"));
  });

  it("follows a changed default for the next new workspace", async () => {
    const { prefsStore } = await import("@/store/prefs");
    prefsStore.setDefaultModel("gpt-5.5");
    const thread = { id: 2, provider: "codex", model: null };
    expect(seedForSelectedThread(thread, {}, prefsStore.seedModelFor)).toBe("gpt-5.5");
  });

  it("falls back to the provider's first model when the default is another provider's", async () => {
    const { prefsStore } = await import("@/store/prefs");
    prefsStore.setDefaultModel("claude-sonnet-5");
    const thread = { id: 3, provider: "codex", model: null };
    expect(seedForSelectedThread(thread, {}, prefsStore.seedModelFor)).toBe(firstModel("codex"));
  });

  it("leaves a chat that already has a model alone", async () => {
    const { prefsStore } = await import("@/store/prefs");
    prefsStore.setDefaultModel("claude-opus-5");
    const thread = { id: 4, provider: "claude", model: "claude-haiku-4-5" };
    expect(seedForSelectedThread(thread, {}, prefsStore.seedModelFor)).toBeUndefined();
  });

  it("keeps a seed newChat() already recorded", async () => {
    const { prefsStore } = await import("@/store/prefs");
    prefsStore.setDefaultModel("claude-opus-5");
    const thread = { id: 5, provider: "claude", model: null };
    expect(seedForSelectedThread(thread, { 5: "claude-sonnet-5" }, prefsStore.seedModelFor)).toBeUndefined();
  });
});
