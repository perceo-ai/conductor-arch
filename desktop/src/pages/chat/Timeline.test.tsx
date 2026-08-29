// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { ArchcarProjectionItem, ProviderInteractionRecord } from "@/bridge/protocol";

/**
 * Mounting the real component, not just its helpers.
 *
 * `withoutPlanSource` and `showsNewChatIntro` are unit-tested against arrays;
 * what those tests cannot see is whether Timeline actually renders. Solid
 * evaluates `createMemo` eagerly, so the memo that filters the plan's source
 * message out reads `pendingPlan` at construction time — declare `pendingPlan`
 * after it and the whole chat surface dies on a temporal-dead-zone
 * ReferenceError that no array test would ever catch.
 */

const PLAN_BODY = "## Step one\n\nDo the thing.";

let items: ArchcarProjectionItem[] = [];
let pending: ProviderInteractionRecord | null = null;

function projectionItem(over: Partial<ArchcarProjectionItem>): ArchcarProjectionItem {
  return {
    id: "x",
    sequence: 1,
    render_class: "assistant_chat",
    role_label: "assistant",
    title: "",
    body: "hi",
    status: "complete",
    stream_state: "complete",
    ...over,
  };
}

function planRecord(detail: string): ProviderInteractionRecord {
  return {
    id: "int-1",
    provider_key: "codex",
    workspace: "smoke",
    thread_id: 1,
    session_id: 1,
    kind: "plan_approval",
    title: "Plan ready for review",
    detail,
    questions: [],
    plan_path: ".context/plans/p.md",
    status: "pending",
  };
}

vi.mock("@/store", () => ({
  chatStore: { slice: () => ({ session: { ready: true }, phase: { kind: "ready" }, queue: [] }) },
  interactionsStore: { pending: () => pending },
  actions: { resolveInteraction: vi.fn(() => Promise.resolve()), revealPanel: vi.fn() },
}));
vi.mock("@/store/actions", () => ({
  actions: { resolveInteraction: vi.fn(() => Promise.resolve()), revealPanel: vi.fn() },
}));
vi.mock("@/store/chat", () => ({ timelineItemsForSlice: () => items }));
vi.mock("./NewChatIntro", () => ({
  NewChatIntro: () => <div class="new-chat-intro">new chat</div>,
}));

// jsdom implements no scrolling at all, and Timeline scrolls to the bottom on
// mount. Without this the component works but the rAF callback throws.
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

const { Timeline } = await import("./Timeline");

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <Timeline threadId={1} workspace="smoke" />, host);
  return host;
}

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
  items = [];
  pending = null;
});

describe("Timeline", () => {
  it("mounts", () => {
    items = [projectionItem({ id: "a", body: "hello" })];
    expect(mount().querySelector(".chat-timeline-scroll")).toBeTruthy();
  });

  it("renders the plan once when the card was lifted from the last message", () => {
    items = [
      projectionItem({ id: "a", body: "on it" }),
      projectionItem({ id: "b", body: PLAN_BODY }),
    ];
    pending = planRecord(PLAN_BODY);
    const el = mount();
    expect(el.querySelectorAll(".chat-plan-card")).toHaveLength(1);
    // The message it came from is gone, so "Step one" appears exactly once.
    expect(el.textContent!.split("Step one").length - 1).toBe(1);
  });

  it("keeps the message once the plan is no longer pending", () => {
    items = [projectionItem({ id: "b", body: PLAN_BODY })];
    pending = null;
    const el = mount();
    expect(el.querySelector(".chat-plan-card")).toBeNull();
    expect(el.textContent).toContain("Step one");
  });

  it("does not fall back to the new-chat intro when the only message became the card", () => {
    items = [projectionItem({ id: "b", body: PLAN_BODY })];
    pending = planRecord(PLAN_BODY);
    const el = mount();
    expect(el.querySelector(".new-chat-intro")).toBeNull();
    expect(el.querySelector(".chat-plan-card")).toBeTruthy();
  });

  it("still shows the intro on a genuinely empty thread", () => {
    const el = mount();
    expect(el.querySelector(".new-chat-intro")).toBeTruthy();
  });
});
