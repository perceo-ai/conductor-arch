// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

async function freshChatStore() {
  vi.resetModules();
  return import("./chat");
}

function emptySnapshot(threadId: number) {
  return {
    thread_id: threadId,
    messages: [],
    events: [],
    provider_events: [],
    queued_inputs: [],
    live_session: undefined,
  };
}

describe("chatStore optimistic messages", () => {
  it("keeps a pending user message visible when a stale snapshot arrives", async () => {
    const { chatStore, timelineItemsForSlice } = await freshChatStore();
    chatStore.optimisticAppend(7, {
      id: -1,
      role: "user",
      content: "fix the disappearing send",
      source: "desktop_optimistic",
    });

    chatStore.applySnapshot(emptySnapshot(7));

    expect(timelineItemsForSlice(chatStore.slice(7)).map((item) => item.body)).toEqual([
      "fix the disappearing send",
    ]);
    expect(timelineItemsForSlice(chatStore.slice(7))[0]).toMatchObject({
      render_class: "user_chat",
      status: "pending",
    });
  });

  it("removes the pending copy once the persisted user message is in the snapshot", async () => {
    const { chatStore, timelineItemsForSlice } = await freshChatStore();
    chatStore.optimisticAppend(7, {
      id: -1,
      role: "user",
      content: "run tests",
      source: "desktop_optimistic",
    });

    chatStore.applySnapshot({
      ...emptySnapshot(7),
      messages: [{ id: 42, role: "user", content: "run tests", source: "user_send" }],
    });

    expect(chatStore.slice(7).pendingMessages).toEqual([]);
    expect(timelineItemsForSlice(chatStore.slice(7)).map((item) => item.id)).toEqual(["msg-42"]);
  });

  it("does not drop a repeated pending message because an older matching body exists", async () => {
    const { chatStore, timelineItemsForSlice } = await freshChatStore();
    chatStore.applySnapshot({
      ...emptySnapshot(7),
      messages: [{ id: 41, role: "user", content: "repeat me", source: "user_send" }],
    });
    chatStore.optimisticAppend(7, {
      id: -1,
      role: "user",
      content: "repeat me",
      source: "desktop_optimistic",
    });

    chatStore.applySnapshot({
      ...emptySnapshot(7),
      messages: [{ id: 41, role: "user", content: "repeat me", source: "user_send" }],
    });

    expect(chatStore.slice(7).pendingMessages.map((m) => m.id)).toEqual([-1]);
    expect(timelineItemsForSlice(chatStore.slice(7)).map((item) => item.id)).toEqual([
      "msg-41",
      "msg--1",
    ]);
  });

  it("retires only one pending duplicate per newly persisted matching message", async () => {
    const { chatStore } = await freshChatStore();
    chatStore.optimisticAppend(7, {
      id: -1,
      role: "user",
      content: "same",
      source: "desktop_optimistic",
    });
    chatStore.optimisticAppend(7, {
      id: -2,
      role: "user",
      content: "same",
      source: "desktop_optimistic",
    });

    chatStore.applySnapshot({
      ...emptySnapshot(7),
      messages: [{ id: 42, role: "user", content: "same", source: "user_send" }],
    });

    expect(chatStore.slice(7).pendingMessages.map((m) => m.id)).toEqual([-2]);
  });

  it("keeps pending user input visible beside structured projection items", async () => {
    const { chatStore, timelineItemsForSlice } = await freshChatStore();
    chatStore.setProjection(7, [
      {
        id: "provider-turn-1",
        sequence: 1,
        render_class: "reasoning_card",
        role_label: "reasoning",
        title: "Thinking",
        body: "Inspecting the failing request.",
        status: "running",
        stream_state: "streaming",
      },
    ]);
    chatStore.optimisticAppend(7, {
      id: -1,
      role: "user",
      content: "why did my message disappear?",
      source: "desktop_optimistic",
    });

    expect(timelineItemsForSlice(chatStore.slice(7)).map((item) => item.body)).toEqual([
      "Inspecting the failing request.",
      "why did my message disappear?",
    ]);
  });
});
