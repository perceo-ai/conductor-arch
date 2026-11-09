// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.fn(async (request: { type: string; index?: number }) => {
  if (request.type === "get_chat_image") {
    return {
      type: "chat_image",
      thread_id: 7,
      item_id: "claude:t:toolu_1",
      index: request.index,
      media_type: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUg==",
    };
  }
  throw new Error(`Unexpected request: ${request.type}`);
});

vi.mock("@/bridge/client", () => ({ send }));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  send.mockClear();
});

async function mount(images: { media_type: string; bytes: number }[]) {
  vi.resetModules();
  const { render } = await import("solid-js/web");
  const ChatImages = (await import("./ChatImages")).default;
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => <ChatImages threadId={7} itemId="claude:t:toolu_1" images={images} />,
    host,
  );
  return host;
}

describe("images a tool result carried", () => {
  it("draws a small image as soon as the card renders", async () => {
    const host = await mount([{ media_type: "image/png", bytes: 16 }]);

    const img = await vi.waitFor(() => {
      const el = host.querySelector<HTMLImageElement>("img.chat-image");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==");
    expect(send).toHaveBeenCalledWith({
      type: "get_chat_image",
      thread_id: 7,
      item_id: "claude:t:toolu_1",
      index: 0,
    });

    // Click enlarges, click again shrinks: a UI screenshot is unreadable at
    // thumbnail size, and a pinned full-size image would push the chat apart.
    img.click();
    expect(img.classList.contains("chat-image-full")).toBe(true);
    img.click();
    expect(img.classList.contains("chat-image-full")).toBe(false);
  });

  it("holds a large image behind a click so opening a chat stays cheap", async () => {
    const host = await mount([{ media_type: "image/png", bytes: 9 * 1024 * 1024 }]);

    const button = host.querySelector<HTMLButtonElement>("button.chat-image-deferred")!;
    expect(button.textContent).toBe("Show image (9.0 MB)");
    expect(send).not.toHaveBeenCalled();

    button.click();
    await vi.waitFor(() => expect(host.querySelector("img.chat-image")).toBeTruthy());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fetches each image of a multi-image result by its own index", async () => {
    const host = await mount([
      { media_type: "image/png", bytes: 16 },
      { media_type: "image/jpeg", bytes: 32 },
    ]);

    await vi.waitFor(() => expect(host.querySelectorAll("img.chat-image")).toHaveLength(2));
    expect(send.mock.calls.map(([request]) => request.index)).toEqual([0, 1]);
  });

  it("keeps a failed image to its own error, leaving the rest of the strip standing", async () => {
    send.mockRejectedValueOnce(new Error("image gone"));

    const host = await mount([
      { media_type: "image/png", bytes: 16 },
      { media_type: "image/jpeg", bytes: 32 },
    ]);

    await vi.waitFor(() => {
      expect(host.querySelector(".chat-image-error")?.textContent).toBe(
        "Image unavailable: image gone",
      );
      expect(host.querySelectorAll("img.chat-image")).toHaveLength(1);
    });
    expect(host.querySelector(".chat-image-strip")).toBeTruthy();
  });

  it("enlarges and shrinks from the keyboard", async () => {
    const host = await mount([{ media_type: "image/png", bytes: 16 }]);
    const img = await vi.waitFor(() => {
      const el = host.querySelector<HTMLImageElement>("img.chat-image");
      expect(el).toBeTruthy();
      return el!;
    });

    expect(img.tabIndex).toBe(0);
    expect(img.getAttribute("role")).toBe("button");
    expect(img.getAttribute("aria-label")).toBe("Click to enlarge");

    img.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(img.classList.contains("chat-image-full")).toBe(true);
    expect(img.getAttribute("aria-label")).toBe("Click to shrink");

    // Space scrolls the page unless the handler claims it.
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    img.dispatchEvent(space);
    expect(img.classList.contains("chat-image-full")).toBe(false);
    expect(space.defaultPrevented).toBe(true);

    img.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(img.classList.contains("chat-image-full")).toBe(false);
  });
});
