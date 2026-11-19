// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { AttentionItem } from "@/bridge/protocol";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    kind: "agent_asked",
    workspace: "ws",
    repository: "repo",
    thread_id: null,
    session_id: null,
    headline: "headline",
    detail: null,
    rank: 0,
    ...overrides,
  };
}

let items: AttentionItem[] = [];
const send = vi.fn(async () => ({
  type: "attention",
  queue: { generated_at: "2026-11-19T22:28:36Z", items },
}));
vi.mock("@/bridge/client", () => ({ send }));

const selectWorkspace = vi.fn();
const selectChatThread = vi.fn();
vi.mock("@/store/nav", async (orig) => {
  const mod = await orig<typeof import("@/store/nav")>();
  return { ...mod, nav: { ...mod.nav, selectWorkspace, selectChatThread } };
});

const { AttentionPage } = await import("./Attention");
const { attentionStore } = await import("@/store/attention");
const { workspacesStore } = await import("@/store/workspaces");

function knowWorkspaces(...names: string[]) {
  workspacesStore.setAll(names.map((name) => ({ name }) as never));
}

let dispose: (() => void) | undefined;
function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <AttentionPage />, host);
  return host;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  dispose?.();
  dispose = undefined;
  attentionStore.reset();
  document.body.innerHTML = "";
  workspacesStore.setAll([]);
  selectWorkspace.mockClear();
  selectChatThread.mockClear();
});

describe("Attention page", () => {
  it("renders one row per item with its workspace and headline", async () => {
    items = [
      item({ workspace: "alpha", headline: "Agent asked a question" }),
      item({ workspace: "beta", headline: "Checks failed", kind: "checks_failed", rank: 3 }),
    ];
    const host = mount();
    await settle();
    const rows = host.querySelectorAll("[data-attention-row]");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("alpha");
    expect(rows[0].textContent).toContain("Agent asked a question");
    expect(rows[1].textContent).toContain("beta");
    expect(rows[1].getAttribute("data-kind")).toBe("checks_failed");
  });

  it("presents a stalled session as might be stuck, not stuck", async () => {
    items = [item({ kind: "stalled", rank: 1, headline: "No output for 12m" })];
    const host = mount();
    await settle();
    const row = host.querySelector("[data-attention-row]")!;
    expect(row.getAttribute("title")).toBe("Might be stuck");
  });

  it("shows when the queue was generated", async () => {
    items = [item()];
    const host = mount();
    await settle();
    expect(host.querySelector(".attention-asof")?.textContent).toMatch(/^As of /);
  });

  it("renders an empty state when nothing needs the human", async () => {
    items = [];
    const host = mount();
    await settle();
    expect(host.querySelectorAll("[data-attention-row]")).toHaveLength(0);
    expect(host.textContent).toContain("Nothing needs you");
  });

  it("navigates to the item's workspace and thread when a row is activated", async () => {
    knowWorkspaces("alpha");
    items = [item({ workspace: "alpha", thread_id: 42 })];
    const host = mount();
    await settle();
    (host.querySelector("[data-attention-row]") as HTMLElement).click();
    expect(selectWorkspace).toHaveBeenCalledWith("alpha");
    expect(selectChatThread).toHaveBeenCalledWith(42);
  });

  it("opens just the workspace when the item names no thread", async () => {
    knowWorkspaces("alpha");
    items = [item({ workspace: "alpha", thread_id: null })];
    const host = mount();
    await settle();
    (host.querySelector("[data-attention-row]") as HTMLElement).click();
    expect(selectWorkspace).toHaveBeenCalledWith("alpha");
    expect(selectChatThread).not.toHaveBeenCalled();
  });

  it("does not navigate for an item whose workspace does not exist, and says why", async () => {
    knowWorkspaces("alpha");
    items = [
      item({
        kind: "task_finished",
        workspace: "repo-only",
        rank: 2,
        headline: "Background task failed: x",
        detail: "No workspace was created for this task",
      }),
    ];
    const host = mount();
    await settle();
    const row = host.querySelector("[data-attention-row]") as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain("No workspace was created for this task");
    row.click();
    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it("shows a placeholder, not blank space, until the first answer lands", async () => {
    items = [];
    const host = mount();
    expect(host.textContent).toContain("Checking");
    expect(host.textContent).not.toContain("Nothing needs you");
    await settle();
    expect(host.textContent).toContain("Nothing needs you");
  });

  it("has a refresh button that refetches", async () => {
    items = [];
    const host = mount();
    await settle();
    const before = send.mock.calls.length;
    (host.querySelector(".attention-refresh") as HTMLButtonElement).click();
    await settle();
    expect(send.mock.calls.length).toBe(before + 1);
  });
});
