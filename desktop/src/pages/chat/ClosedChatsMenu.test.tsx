import { createSignal } from "solid-js";
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

  it("drops a list reply for the workspace the user already switched away from", async () => {
    // A's request is still in flight when the user moves to B and reopens the
    // menu; A's late reply must not replace B's list, or picking one would
    // reopen A's chat while the parent searched B for it.
    const pending: Record<string, (value: unknown) => void> = {};
    send.mockImplementation(
      (req: { workspace: string }) =>
        new Promise((resolve) => {
          pending[req.workspace] = resolve;
        }),
    );
    const [workspace, setWorkspace] = createSignal("berlin");
    const host = mount(() => <ClosedChatsMenu workspace={workspace()} onRestored={() => {}} />);

    trigger(host)!.click();
    await vi.waitFor(() => expect(pending.berlin).toBeDefined());
    setWorkspace("paris");
    trigger(host)!.click();
    await vi.waitFor(() => expect(pending.paris).toBeDefined());

    pending.paris({
      type: "chat_threads",
      workspace: "paris",
      threads: [thread({ id: 9, title: "Paris chat" })],
    });
    await vi.waitFor(() => expect(items().length).toBe(1));
    pending.berlin({
      type: "chat_threads",
      workspace: "berlin",
      threads: [thread({ id: 7, title: "Berlin chat" })],
    });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(items()).toHaveLength(1);
    expect(items()[0]).toContain("Paris chat");
  });

  it("closes and forgets the list when the workspace changes", async () => {
    send.mockResolvedValue({
      type: "chat_threads",
      workspace: "berlin",
      threads: [thread({ id: 7, title: "Berlin chat" })],
    });
    const [workspace, setWorkspace] = createSignal("berlin");
    const host = mount(() => <ClosedChatsMenu workspace={workspace()} onRestored={() => {}} />);

    trigger(host)!.click();
    await vi.waitFor(() => expect(items().length).toBe(1));
    setWorkspace("paris");

    expect(document.querySelector(".ws-closed-chats-menu")).toBeNull();
    expect(items()).toEqual([]);
  });

  it("shows a failed list as an error with a retry, not as an empty menu", async () => {
    send.mockRejectedValueOnce(new Error("daemon unreachable"));
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={() => {}} />);

    trigger(host)!.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".ws-closed-chats-error")).not.toBeNull(),
    );
    expect(document.querySelector(".ws-closed-chats-error")!.textContent).toContain(
      "daemon unreachable",
    );
    expect(document.querySelector(".ws-closed-chats-empty")).toBeNull();

    send.mockResolvedValueOnce({
      type: "chat_threads",
      workspace: "berlin",
      threads: [thread({ id: 7, title: "Yesterday's work" })],
    });
    document.querySelector<HTMLButtonElement>(".ws-closed-chats-retry")!.click();
    await vi.waitFor(() => expect(items().length).toBe(1));

    expect(document.querySelector(".ws-closed-chats-error")).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected restore and keeps the menu open", async () => {
    const restored = vi.fn();
    send.mockImplementation(async (req: { type: string }) => {
      if (req.type === "reopen_chat_thread") throw new Error("thread is gone");
      return {
        type: "chat_threads",
        workspace: "berlin",
        threads: [thread({ id: 7, title: "Yesterday's work" })],
      };
    });
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={restored} />);

    trigger(host)!.click();
    await vi.waitFor(() => expect(items().length).toBe(1));
    document.querySelector<HTMLElement>(".ws-closed-chat-item")!.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".ws-closed-chats-error")).not.toBeNull(),
    );

    expect(document.querySelector(".ws-closed-chats-error")!.textContent).toContain(
      "thread is gone",
    );
    expect(items()).toHaveLength(1);
    expect(restored).not.toHaveBeenCalled();
  });

  it("reports a restore the daemon refused and keeps the chat listed", async () => {
    // The daemon answers a failed reopen with a resolved error reply, never a
    // rejection; treating that as success told the parent to open a chat that
    // was still closed.
    const restored = vi.fn();
    send.mockImplementation(async (req: { type: string }) =>
      req.type === "reopen_chat_thread"
        ? { type: "error", message: "chat thread 7 not found" }
        : {
            type: "chat_threads",
            workspace: "berlin",
            threads: [thread({ id: 7, title: "Yesterday's work" })],
          },
    );
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={restored} />);

    trigger(host)!.click();
    await vi.waitFor(() => expect(items().length).toBe(1));
    document.querySelector<HTMLElement>(".ws-closed-chat-item")!.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".ws-closed-chats-error")).not.toBeNull(),
    );

    expect(document.querySelector(".ws-closed-chats-error")!.textContent).toContain(
      "chat thread 7 not found",
    );
    expect(items()).toHaveLength(1);
    expect(restored).not.toHaveBeenCalled();
  });

  it("shows the daemon's message when listing is refused", async () => {
    send.mockResolvedValueOnce({ type: "error", message: "workspace berlin is not known" });
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={() => {}} />);

    trigger(host)!.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".ws-closed-chats-error")).not.toBeNull(),
    );

    expect(document.querySelector(".ws-closed-chats-error")!.textContent).toContain(
      "workspace berlin is not known",
    );
    expect(document.querySelector(".ws-closed-chats-retry")).not.toBeNull();
  });

  it("still reports a restore that lands after the menu was closed and reopened", async () => {
    // Reopening the menu re-lists, which advances the list generation; a
    // restore still in flight for the same workspace must not be mistaken for
    // a stale reply, or the reopened chat never reaches the tab strip.
    const restored = vi.fn();
    let finishRestore: (value: unknown) => void = () => {};
    send.mockImplementation((req: { type: string }) =>
      req.type === "reopen_chat_thread"
        ? new Promise((resolve) => {
            finishRestore = resolve;
          })
        : Promise.resolve({
            type: "chat_threads",
            workspace: "berlin",
            threads: [thread({ id: 7, title: "Yesterday's work" })],
          }),
    );
    const host = mount(() => <ClosedChatsMenu workspace="berlin" onRestored={restored} />);

    trigger(host)!.click();
    await vi.waitFor(() => expect(items().length).toBe(1));
    document.querySelector<HTMLElement>(".ws-closed-chat-item")!.click();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: "reopen_chat_thread", thread_id: 7 }),
    );
    trigger(host)!.click();
    expect(document.querySelector(".ws-closed-chats-menu")).toBeNull();
    trigger(host)!.click();
    await vi.waitFor(() => expect(items().length).toBe(1));

    finishRestore({ type: "ack" });
    await vi.waitFor(() => expect(restored).toHaveBeenCalled());

    expect(restored).toHaveBeenCalledTimes(1);
    expect(restored).toHaveBeenCalledWith(7);
  });

  it("drops a restore that lands after the user switched workspace", async () => {
    // The chat is reopened in the workspace that listed it; telling the parent
    // would make it search the new workspace for a chat that is not there.
    const restored = vi.fn();
    let finishRestore: (value: unknown) => void = () => {};
    send.mockImplementation((req: { type: string }) =>
      req.type === "reopen_chat_thread"
        ? new Promise((resolve) => {
            finishRestore = resolve;
          })
        : Promise.resolve({
            type: "chat_threads",
            workspace: "berlin",
            threads: [thread({ id: 7, title: "Berlin chat" })],
          }),
    );
    const [workspace, setWorkspace] = createSignal("berlin");
    const host = mount(() => <ClosedChatsMenu workspace={workspace()} onRestored={restored} />);

    trigger(host)!.click();
    await vi.waitFor(() => expect(items().length).toBe(1));
    document.querySelector<HTMLElement>(".ws-closed-chat-item")!.click();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: "reopen_chat_thread", thread_id: 7 }),
    );
    setWorkspace("paris");
    finishRestore({ type: "ack" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(restored).not.toHaveBeenCalled();
  });
});
