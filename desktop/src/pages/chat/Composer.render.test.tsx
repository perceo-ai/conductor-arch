// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

const send = vi.fn();
vi.mock("@/bridge/client", () => ({
  send: (...args: unknown[]) => send(...args),
  openExternal: vi.fn(),
}));

import { Composer } from "./Composer";
import { composerDraftsStore } from "@/store";

/**
 * A draft belongs to the chat it was typed into. The composer is not remounted
 * when the reader switches chats, and it is destroyed when the chat surface
 * shows a file or a commit — so a component-local draft both followed the
 * reader into the next chat and vanished when they looked at a diff.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function editor(host: HTMLElement): HTMLElement {
  const el = host.querySelector<HTMLElement>(".chat-input-view");
  if (!el) throw new Error("composer input not rendered");
  return el;
}

function type(host: HTMLElement, value: string) {
  const el = editor(host);
  el.textContent = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  composerDraftsStore.clear(1);
  composerDraftsStore.clear(2);
  send.mockReset();
  document.body.innerHTML = "";
});

function mount(threadId: () => number) {
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(
    () => (
      <Composer
        threadId={threadId()}
        workspace="ws"
        provider="claude"
        onChangeAgentModel={() => {}}
      />
    ),
    host,
  );
  return { host, dispose };
}

describe("Composer drafts", () => {
  it("survives the composer being unmounted and remounted", async () => {
    send.mockResolvedValue({ type: "skills", skills: [] });
    const first = mount(() => 1);
    await flush();
    type(first.host, "half a thought");
    expect(composerDraftsStore.nodes(1)).toEqual([{ kind: "text", text: "half a thought" }]);

    // Opening a file or a commit tears the composer down.
    first.dispose();
    first.host.remove();

    const second = mount(() => 1);
    await flush();
    expect(editor(second.host).textContent).toBe("half a thought");
    second.dispose();
  });

  it("does not carry a draft into another chat", async () => {
    send.mockResolvedValue({ type: "skills", skills: [] });
    const [threadId, setThreadId] = createSignal(1);
    const { host, dispose } = mount(threadId);
    await flush();
    type(host, "meant for chat one");

    setThreadId(2);
    await flush();
    expect(editor(host).textContent).toBe("");
    expect(composerDraftsStore.nodes(2)).toEqual([]);

    // And it is still waiting back in the chat it was typed into.
    setThreadId(1);
    await flush();
    expect(editor(host).textContent).toBe("meant for chat one");
    expect(composerDraftsStore.nodes(1)).toEqual([
      { kind: "text", text: "meant for chat one" },
    ]);
    dispose();
  });
});
