import { render } from "solid-js/web";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ClosedChatsMenu } from "./ClosedChatsMenu";
import type { ArchcarChatThread } from "@/bridge/protocol";

const send = vi.fn();
vi.mock("@/bridge/client", () => ({
  send: (...args: unknown[]) => send(...args),
}));

function thread(over: Partial<ArchcarChatThread>): ArchcarChatThread {
  return {
    id: 1,
    provider: "codex",
    title: "A chat",
    status: "closed",
    updated_at: "1700000000",
    archived_at: "1700000000",
    fast_mode: false,
    ...over,
  } as ArchcarChatThread;
}

function mount(node: () => unknown) {
  const host = document.createElement("div");
  document.body.append(host);
  render(node as never, host);
  return host;
}

function trigger(host: HTMLElement) {
  return host.querySelector<HTMLButtonElement>("button[aria-label='Restore closed chat']");
}

function items() {
  return [...document.querySelectorAll<HTMLElement>(".ws-closed-chat-item")].map((el) =>
    (el.textContent ?? "").trim(),
  );
}

describe("ClosedChatsMenu", () => {
  beforeEach(() => {
    send.mockReset();
    document.body.innerHTML = "";
  });

  it("offers a restore control beside the new-chat button", () => {
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={() => {}} />);

    expect(trigger(host)).not.toBeNull();
  });

  it("asks the daemon for this workspace's closed chats when opened", async () => {
    send.mockResolvedValue({ type: "chat_threads", workspace: "berlin", threads: [] });
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={() => {}} />);

    trigger(host)!.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(send).toHaveBeenCalledWith({
      type: "list_closed_chat_threads",
      workspace: "berlin",
    });
  });

  it("lists closed chats in the order the daemon gave them", async () => {
    send.mockResolvedValue({
      type: "chat_threads",
      workspace: "berlin",
      threads: [
        thread({ id: 7, title: "Yesterday's work" }),
        thread({ id: 3, title: "Last week's spike" }),
      ],
    });
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={() => {}} />);

    trigger(host)!.click();
    await vi.waitFor(() => expect(items().length).toBe(2));

    expect(items()[0]).toContain("Yesterday's work");
    expect(items()[1]).toContain("Last week's spike");
  });

  it("reopens the picked chat and reports which one came back", async () => {
    const restored = vi.fn();
    send.mockImplementation(async (req: { type: string }) =>
      req.type === "list_closed_chat_threads"
        ? {
            type: "chat_threads",
            workspace: "berlin",
            threads: [thread({ id: 7, title: "Yesterday's work" })],
          }
        : { type: "ack" },
    );
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={restored} />);

    trigger(host)!.click();
    await vi.waitFor(() => expect(items().length).toBe(1));
    document.querySelector<HTMLElement>(".ws-closed-chat-item")!.click();
    await vi.waitFor(() => expect(restored).toHaveBeenCalled());

    expect(send).toHaveBeenCalledWith({ type: "reopen_chat_thread", thread_id: 7 });
    expect(restored).toHaveBeenCalledWith(7);
  });

  it("closes on Escape without restoring anything", async () => {
    send.mockResolvedValue({
      type: "chat_threads",
      workspace: "berlin",
      threads: [thread({ id: 7 })],
    });
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={() => {}} />);

    trigger(host)!.click();
    await vi.waitFor(() => expect(items().length).toBe(1));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(items()).toEqual([]);
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "reopen_chat_thread" }),
    );
  });

  it("closes when the click lands outside the menu", async () => {
    send.mockResolvedValue({
      type: "chat_threads",
      workspace: "berlin",
      threads: [thread({ id: 7 })],
    });
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={() => {}} />);

    trigger(host)!.click();
    await vi.waitFor(() => expect(items().length).toBe(1));
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(items()).toEqual([]);
  });

  it("says so rather than showing an empty menu when nothing was closed", async () => {
    send.mockResolvedValue({ type: "chat_threads", workspace: "berlin", threads: [] });
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={() => {}} />);

    trigger(host)!.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".ws-closed-chats-empty")).not.toBeNull(),
    );

    expect(document.querySelector(".ws-closed-chats-empty")!.textContent).toContain(
      "No closed chats",
    );
  });
});
