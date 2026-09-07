import { render } from "solid-js/web";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MessageActions, forkMenuItems } from "./MessageActions";
import type { ArchcarProjectionItem } from "@/bridge/protocol";

const forkChat = vi.fn();
vi.mock("@/store", () => ({
  actions: {
    forkChat: (...args: unknown[]) => forkChat(...args),
  },
}));

function item(overrides: Partial<ArchcarProjectionItem> = {}): ArchcarProjectionItem {
  return {
    id: "message:7",
    sequence: 7,
    render_class: "user_chat",
    role_label: "user",
    title: "",
    body: "add a cart",
    status: "complete",
    stream_state: "complete",
    timeline_seq: 42,
    ...overrides,
  };
}

function mount(node: () => unknown) {
  const host = document.createElement("div");
  document.body.append(host);
  render(node as never, host);
  return host;
}

describe("MessageActions", () => {
  beforeEach(() => {
    forkChat.mockReset();
    forkChat.mockResolvedValue({ workspace: "checkout-fork", threadId: 2 });
    document.body.innerHTML = "";
  });

  it("offers both fork actions from the screenshot", () => {
    expect(forkMenuItems({ threadId: 1, timelineSeq: 42 }).map((i) => i.label)).toEqual([
      "Fork to new tab",
      "Fork to new workspace",
    ]);
  });

  it("forks at the item's timeline position, not the whole chat", async () => {
    const items = forkMenuItems({ threadId: 1, timelineSeq: 42 });
    items[0].run();
    await Promise.resolve();

    expect(forkChat).toHaveBeenCalledWith({
      threadId: 1,
      throughTimelineSeq: 42,
      newWorkspace: false,
    });
  });

  it("asks for a workspace only on the second action", async () => {
    const items = forkMenuItems({ threadId: 1, timelineSeq: 42 });
    items[1].run();
    await Promise.resolve();

    expect(forkChat).toHaveBeenCalledWith(
      expect.objectContaining({ newWorkspace: true }),
    );
  });

  it("renders a trigger for a message that has a timeline position", () => {
    const host = mount(() => <MessageActions item={item()} threadId={1} />);
    expect(host.querySelector("button[aria-label='Message actions']")).not.toBeNull();
  });

  it("renders no trigger when the item has no timeline position", () => {
    // Forking "from here" is meaningless without a position, and defaulting to
    // the whole conversation would be a silently different action.
    const host = mount(() => <MessageActions item={item({ timeline_seq: null })} threadId={1} />);
    expect(host.querySelector("button[aria-label='Message actions']")).toBeNull();
  });
});
