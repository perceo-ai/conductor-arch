import { render } from "solid-js/web";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TurnForkAction, forkMenuItems } from "./MessageActions";

const forkChat = vi.fn();
vi.mock("@/store", () => ({
  actions: {
    forkChat: (...args: unknown[]) => forkChat(...args),
  },
}));

function mount(node: () => unknown) {
  const host = document.createElement("div");
  document.body.append(host);
  render(node as never, host);
  return host;
}

describe("TurnForkAction", () => {
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

  it("renders a visible turn action instead of an ellipsis trigger", () => {
    const host = mount(() => <TurnForkAction threadId={1} timelineSeq={42} />);
    const button = host.querySelector("button[aria-label='Fork turn']");

    expect(button?.textContent).toBe("Fork");
    expect(host.querySelector("button[aria-label='Message actions']")).toBeNull();
  });
});
