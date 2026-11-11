// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
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
// Reactive, not a plain variable: a test that reassigns a captured object can
// only prove what the card renders at mount, and the bug worth catching here is
// a spinner that keeps spinning after the state it reads has changed.
const [session, setSession] = createSignal({ runtime_state: "ready", ready: true });
// A reactive feed for tests that change the thread after it is mounted, the
// way the store does while an agent streams. Null falls back to `items`.
const [liveItems, setLiveItems] = createSignal<ArchcarProjectionItem[] | null>(null);

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
  chatStore: {
    slice: () => ({
      get session() {
        return session();
      },
      phase: { kind: "ready" },
      queue: [],
    }),
  },
  interactionsStore: { pending: () => pending },
  actions: { resolveInteraction: vi.fn(() => Promise.resolve()), revealPanel: vi.fn() },
}));
vi.mock("@/store/actions", () => ({
  actions: { resolveInteraction: vi.fn(() => Promise.resolve()), revealPanel: vi.fn() },
}));
vi.mock("@/store/chat", () => ({ timelineItemsForSlice: () => liveItems() ?? items }));
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
  setLiveItems(null);
  pending = null;
  setSession({ runtime_state: "ready", ready: true });
  vi.unstubAllGlobals();
});

/** Records what Timeline observes, so a test can report a resize by hand. */
function stubResizeObserver() {
  const observed: { callback: () => void; targets: Element[]; disconnected: boolean }[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry = { callback: () => {}, targets: [] as Element[], disconnected: false };
      constructor(callback: () => void) {
        this.entry.callback = callback;
        observed.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
  return observed;
}

/** jsdom lays nothing out, so the scroller's size has to be stated. */
function setScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
) {
  Object.defineProperty(el, "clientHeight", { configurable: true, value: metrics.clientHeight });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: metrics.scrollHeight });
  el.scrollTop = metrics.scrollTop;
}

describe("Timeline", () => {
  it("mounts", () => {
    items = [projectionItem({ id: "a", body: "hello" })];
    expect(mount().querySelector(".chat-timeline-scroll")).toBeTruthy();
  });

  describe("when the content grows without a new message", () => {
    async function mountScroller() {
      const observed = stubResizeObserver();
      items = [projectionItem({ id: "a", body: "hello" })];
      const el = mount().querySelector<HTMLElement>(".chat-timeline-scroll")!;
      // Let the scrolls queued at mount land before watching for new ones.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const scrollTo = vi.fn();
      el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
      return { el, scrollTo, observed };
    }

    it("stays on the bottom when the reader was following it", async () => {
      const { el, scrollTo, observed } = await mountScroller();
      expect(observed[0]?.targets).toEqual([el.querySelector(".chat-messages")]);
      setScrollMetrics(el, { scrollTop: 600, clientHeight: 300, scrollHeight: 900 });
      el.dispatchEvent(new Event("scroll"));

      // An image finished loading: taller content, no new message, no scroll.
      setScrollMetrics(el, { scrollTop: 600, clientHeight: 300, scrollHeight: 1400 });
      observed[0].callback();

      expect(scrollTo).toHaveBeenCalledWith({ top: 1100, behavior: "instant" });
    });

    it("stays pinned when a second image lands before the first scroll settles", async () => {
      const { el, observed } = await mountScroller();
      // What the browser does here: `.chat-timeline-scroll` sets `scroll-behavior:
      // smooth`, so anything but "instant" starts an animation, and its scroll
      // events report the positions on the way there.
      el.scrollTo = ((options: ScrollToOptions) => {
        const target = options.top ?? 0;
        el.scrollTop =
          options.behavior === "instant" ? target : el.scrollTop + (target - el.scrollTop) / 2;
        el.dispatchEvent(new Event("scroll"));
      }) as typeof el.scrollTo;
      setScrollMetrics(el, { scrollTop: 600, clientHeight: 300, scrollHeight: 900 });
      el.dispatchEvent(new Event("scroll"));

      setScrollMetrics(el, { scrollTop: el.scrollTop, clientHeight: 300, scrollHeight: 1400 });
      observed[0].callback();
      setScrollMetrics(el, { scrollTop: el.scrollTop, clientHeight: 300, scrollHeight: 1900 });
      observed[0].callback();

      expect(el.scrollTop).toBe(1600);
    });

    it("leaves a reader who scrolled up where they are", async () => {
      const { el, scrollTo, observed } = await mountScroller();
      setScrollMetrics(el, { scrollTop: 100, clientHeight: 300, scrollHeight: 900 });
      el.dispatchEvent(new Event("scroll"));

      setScrollMetrics(el, { scrollTop: 100, clientHeight: 300, scrollHeight: 1400 });
      observed[0].callback();

      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("stops observing when the timeline goes away", async () => {
      const { observed } = await mountScroller();

      dispose?.();
      dispose = undefined;

      expect(observed[0].disconnected).toBe(true);
    });
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

  it("shows one persistent fork control after the final assistant message in each completed turn", () => {
    items = [
      projectionItem({ id: "u1", render_class: "user_chat", body: "first", timeline_seq: 1 }),
      projectionItem({ id: "a1", body: "working", timeline_seq: 2 }),
      projectionItem({ id: "a2", body: "first done", timeline_seq: 3 }),
      projectionItem({ id: "u2", render_class: "user_chat", body: "second", timeline_seq: 4 }),
      projectionItem({ id: "a3", body: "second done", timeline_seq: 5 }),
    ];

    const turns = [...mount().querySelectorAll(".chat-agent-turn")];
    expect(turns.map((turn) => turn.querySelector("button[aria-label='Fork turn']") != null)).toEqual([
      false,
      true,
      true,
    ]);
    expect(
      turns
        .filter((turn) => turn.querySelector("button[aria-label='Fork turn']"))
        .map((turn) => turn.querySelector(".chat-agent-text")?.textContent?.trim()),
    ).toEqual(["first done", "second done"]);
  });

  it("withholds the current turn fork control until generation finishes", () => {
    setSession({ runtime_state: "running", ready: false });
    items = [
      projectionItem({ id: "u1", render_class: "user_chat", body: "first", timeline_seq: 1 }),
      projectionItem({ id: "a1", body: "first done", timeline_seq: 2 }),
      projectionItem({ id: "u2", render_class: "user_chat", body: "second", timeline_seq: 3 }),
      projectionItem({ id: "a2", body: "still working", timeline_seq: 4 }),
    ];

    const turns = [...mount().querySelectorAll(".chat-agent-turn")];
    expect(turns.map((turn) => turn.querySelector("button[aria-label='Fork turn']") != null)).toEqual([
      true,
      false,
    ]);
  });

  it("mounts only the newest rows and reveals the rest on demand", () => {
    items = Array.from({ length: 400 }, (_, i) =>
      projectionItem({ id: `m${i}`, body: `message ${i}` }),
    );

    const el = mount();
    const rows = () => [...el.querySelectorAll(".chat-agent-text")].map((r) => r.textContent!.trim());

    expect(rows()).toHaveLength(150);
    // The window holds the end of the thread, which is what the reader is on.
    expect(rows().at(-1)).toBe("message 399");
    expect(rows()[0]).toBe("message 250");

    const reveal = el.querySelector<HTMLButtonElement>(".chat-timeline-reveal-older");
    expect(reveal?.textContent).toContain("250");

    reveal!.click();
    expect(rows()).toHaveLength(300);
    expect(rows()[0]).toBe("message 100");
  });

  it("drops the reveal control once the whole thread is mounted", () => {
    items = Array.from({ length: 20 }, (_, i) =>
      projectionItem({ id: `m${i}`, body: `message ${i}` }),
    );
    const el = mount();
    expect(el.querySelectorAll(".chat-agent-text")).toHaveLength(20);
    expect(el.querySelector(".chat-timeline-reveal-older")).toBeNull();
  });

  it("nests a subagent's rows inside its Agent card, open from the start", () => {
    setSession({ runtime_state: "running", ready: false });
    items = [
      projectionItem({
        id: "agent",
        render_class: "tool_card",
        title: "Agent Audit the renderer",
        body: "",
        status: "running",
        stream_state: "streaming",
      }),
      projectionItem({
        id: "child-call",
        render_class: "command_card",
        title: "Bash rg render_class",
        body: "chatFormat.ts:9",
        parent_id: "agent",
      }),
      projectionItem({
        id: "child-text",
        render_class: "nested_transcript_card",
        title: "Subagent",
        body: "The allowlist lives in chatFormat.ts.",
        parent_id: "agent",
      }),
      projectionItem({ id: "answer", body: "Main agent answer" }),
    ];

    const el = mount();
    const scroll = el.querySelector(".chat-messages")!;
    // One card and one answer at the top level; the subagent's report is not
    // the main agent talking.
    expect(scroll.querySelectorAll(":scope > .chat-inline-event")).toHaveLength(1);
    expect(el.querySelectorAll(".chat-agent-text")).toHaveLength(1);

    // The subagent's work is the point of the card, so it is already showing.
    const nested = el.querySelector(".chat-inline-event-nested")!;
    expect(nested.textContent).toContain("rg render_class");
    expect(nested.querySelector(".chat-nested-text")?.textContent).toContain(
      "The allowlist lives in chatFormat.ts.",
    );

    // Closing it puts the running card's latest step back in the header.
    el.querySelector<HTMLButtonElement>(".chat-inline-event-expander")!.click();
    expect(el.querySelector(".chat-inline-event-nested")).toBeNull();
    expect(el.textContent).not.toContain("The allowlist lives");
    expect(el.querySelector(".chat-inline-event-latest")?.textContent).toContain("rg render_class");
  });

  // A backgrounded delegation: claude finishes the Agent call the moment the
  // agent is launched, then streams the agent's work under that finished card
  // while a separate task card tracks it. The work still has to read as the
  // subagent's, under the card that delegated.
  it("shows a backgrounded subagent's work under its finished Agent card", () => {
    items = [
      projectionItem({
        id: "agent",
        render_class: "tool_card",
        title: "Agent two step",
        body: "Working in the background.",
      }),
      projectionItem({
        id: "task",
        render_class: "background_card",
        title: "two step",
        body: "`notes.md` has 2 lines.",
        status: "running",
      }),
      projectionItem({
        id: "child-ls",
        render_class: "command_card",
        title: "Bash ls",
        body: "notes.md\none.txt",
        parent_id: "agent",
      }),
      projectionItem({
        id: "child-text",
        render_class: "nested_transcript_card",
        title: "Subagent",
        body: "The directory holds two files.",
        parent_id: "agent",
      }),
    ];

    const el = mount();
    const scroll = el.querySelector(".chat-messages")!;
    // The Agent card and the task card, each at the top level.
    expect(scroll.querySelectorAll(":scope > .chat-inline-event")).toHaveLength(2);

    // The delegation opens on its own work, and the launch line is all the
    // card itself has to say.
    const nested = el.querySelector(".chat-inline-event-nested")!;
    expect(nested.textContent).toContain("Bash ls");
    expect(nested.querySelector(".chat-nested-text")?.textContent).toContain(
      "The directory holds two files.",
    );
    expect(el.textContent).toContain("Working in the background.");
    expect(el.textContent).not.toContain("agentId");
  });

  it("shows the subagent's action count in the collapsed Agent card header", () => {
    items = [
      projectionItem({ id: "agent", render_class: "tool_card", title: "Agent Audit the renderer", body: "" }),
      // The prompt the subagent was handed is not one of its actions.
      projectionItem({
        id: "prompt",
        render_class: "subagent_card",
        title: "Asked subagent",
        body: "Audit the renderer.",
        parent_id: "agent",
      }),
      ...Array.from({ length: 12 }, (_, i) =>
        projectionItem({
          id: `call-${i}`,
          render_class: "command_card",
          title: `Bash rg pattern${i}`,
          body: "",
          parent_id: "agent",
        }),
      ),
      // The subagent's narration is not an action.
      projectionItem({
        id: "report",
        render_class: "nested_transcript_card",
        title: "Subagent",
        body: "Done.",
        parent_id: "agent",
      }),
    ];
    const el = mount();
    const header = el.querySelector(".chat-inline-event-header")!;
    expect(header.querySelector(".chat-inline-event-count")?.textContent).toBe("12 actions");
    // Finished, so it neither spins nor shows a latest-action line.
    expect(el.querySelector(".chat-inline-event-running")).toBeNull();
    expect(header.querySelector(".chat-inline-event-latest")).toBeNull();
  });

  it("caps an open Agent card with 100+ actions and reveals older ones on demand", () => {
    items = [
      projectionItem({ id: "agent", render_class: "tool_card", title: "Agent Sweep the repo", body: "" }),
      ...Array.from({ length: 120 }, (_, i) =>
        projectionItem({
          id: `call-${i}`,
          render_class: "command_card",
          title: `Bash rg step${i}`,
          body: "",
          parent_id: "agent",
        }),
      ),
    ];
    const el = mount();
    expect(el.querySelector(".chat-inline-event-count")?.textContent).toBe("120 actions");
    el.querySelector<HTMLButtonElement>(".chat-inline-event-expander")!.click();

    const nested = el.querySelector(".chat-inline-event-nested")!;
    const rows = () => [...nested.querySelectorAll(":scope > .chat-inline-event")].map((r) => r.textContent!);
    expect(rows()).toHaveLength(50);
    // The newest actions stay mounted: a running subagent's work arrives there.
    expect(rows().at(-1)).toContain("step119");
    expect(rows()[0]).toContain("step70");

    const reveal = nested.querySelector<HTMLButtonElement>(":scope > .chat-inline-event-reveal-older");
    expect(reveal?.textContent).toContain("70");
    reveal!.click();
    expect(rows()).toHaveLength(100);
    nested.querySelector<HTMLButtonElement>(":scope > .chat-inline-event-reveal-older")!.click();
    expect(rows()).toHaveLength(120);
    expect(nested.querySelector(".chat-inline-event-reveal-older")).toBeNull();
  });

  it("follows a running subagent's new action into an open, capped card", () => {
    setSession({ runtime_state: "running", ready: false });
    const call = (i: number) =>
      projectionItem({
        id: `call-${i}`,
        render_class: "command_card",
        title: `Bash rg step${i}`,
        body: "",
        parent_id: "agent",
      });
    const agent = projectionItem({
      id: "agent",
      render_class: "tool_card",
      title: "Agent Sweep the repo",
      body: "",
      status: "running",
      stream_state: "streaming",
    });
    const before = [agent, ...Array.from({ length: 110 }, (_, i) => call(i))];
    setLiveItems(before);
    const el = mount();
    const header = el.querySelector(".chat-inline-event-header")!;
    expect(header.querySelector(".chat-inline-event-latest")?.textContent).toContain("step109");
    expect(header.querySelector(".chat-inline-event-count")?.textContent).toBe("110 actions");

    el.querySelector<HTMLButtonElement>(".chat-inline-event-expander")!.click();
    const nested = el.querySelector(".chat-inline-event-nested")!;
    const rows = () => [...nested.querySelectorAll(":scope > .chat-inline-event")].map((r) => r.textContent!);
    const reveal = () => nested.querySelector(":scope > .chat-inline-event-reveal-older")?.textContent;
    expect(rows()).toHaveLength(50);
    expect(rows().at(-1)).toContain("step109");
    expect(reveal()).toContain("60");

    // The subagent takes another action while the card is open and capped.
    setLiveItems([...before, call(110)]);

    // Same card, still open: the window slides to the new action rather than
    // growing past the cap or holding the old rows.
    expect(el.querySelector(".chat-inline-event-nested")).toBe(nested);
    expect(rows()).toHaveLength(50);
    expect(rows().at(-1)).toContain("step110");
    expect(rows()[0]).toContain("step61");
    expect(reveal()).toContain("61");
    expect(header.querySelector(".chat-inline-event-count")?.textContent).toBe("111 actions");
  });

  it("keeps a background task running after the turn goes idle", () => {
    items = [
      projectionItem({
        id: "bg",
        render_class: "background_card",
        title: "Run the test suite",
        body: "",
        status: "running",
        stream_state: "streaming",
      }),
    ];
    const card = mount().querySelector(".chat-inline-event")!;
    expect(card.classList.contains("chat-inline-event-running")).toBe(true);
    expect(card.textContent).toContain("Background");
    expect(card.querySelector(".chat-inline-event-spinner")).not.toBeNull();
  });

  it("marks a running command without attaching the looping loader", () => {
    setSession({ runtime_state: "running", ready: false });
    items = [
      projectionItem({
        id: "cmd",
        render_class: "command_card",
        title: "Ran cargo test",
        body: "",
        status: "running",
      }),
    ];

    const command = mount().querySelector(".chat-inline-event");
    expect(command?.classList.contains("chat-inline-event-running")).toBe(true);
    expect(command?.classList.contains("chat-inline-event-loading")).toBe(false);
    // The visible signal, not just the class: a tint alone left a running
    // command looking the same as a finished one.
    expect(command?.querySelector(".chat-inline-event-spinner")).not.toBeNull();
  });

  // An interrupted or crashed turn leaves its cards marked "running" forever,
  // so the spinner has to come off the card that is already on screen. Asserted
  // across the transition, without remounting: a card that read the state once
  // at mount would pass a static check and still spin for the rest of the
  // session in the real app.
  it("stops spinning a card on screen once the agent goes idle", () => {
    setSession({ runtime_state: "running", ready: false });
    items = [
      projectionItem({
        id: "cmd",
        render_class: "command_card",
        title: "Ran cargo test",
        body: "",
        status: "running",
      }),
    ];

    const el = mount();
    const command = el.querySelector(".chat-inline-event")!;
    expect(command.querySelector(".chat-inline-event-spinner")).not.toBeNull();

    setSession({ runtime_state: "ready", ready: true });

    // Same node, not a re-render of a fresh one.
    expect(el.querySelector(".chat-inline-event")).toBe(command);
    expect(command.querySelector(".chat-inline-event-spinner")).toBeNull();
    expect(command.classList.contains("chat-inline-event-running")).toBe(false);
  });

  it("leaves a finished command without a spinner", () => {
    setSession({ runtime_state: "running", ready: false });
    items = [
      projectionItem({
        id: "cmd",
        render_class: "command_card",
        title: "Ran cargo test",
        body: "",
        status: "complete",
      }),
    ];

    expect(mount().querySelector(".chat-inline-event-spinner")).toBeNull();
  });

  describe("a card that delegated to a subagent", () => {
    // The whole point of these rows: a subagent's reads and writes are the
    // work, and before this they sat behind a "+" that looked exactly like
    // every other tool call's.
    function delegationItems() {
      return [
        projectionItem({
          id: "agent",
          render_class: "tool_card",
          title: "Agent Count .rs files",
          body: "<tools-used-before-summary>Bash</tools-used-before-summary>\n\nFound one file.",
          status: "complete",
        }),
        projectionItem({
          id: "ask",
          parent_id: "agent",
          render_class: "subagent_card",
          title: "Asked subagent",
          body: "Count the .rs files.",
          status: "complete",
        }),
        projectionItem({
          id: "ran",
          parent_id: "agent",
          render_class: "command_card",
          title: "Ran cargo test --lib",
          body: "1",
          status: "complete",
        }),
      ];
    }

    it("shows what the subagent ran without anyone clicking", () => {
      items = delegationItems();
      const nested = mount().querySelector(".chat-inline-event-nested");
      expect(nested).not.toBeNull();
      expect(nested!.textContent).toContain("cargo test --lib");
    });

    it("reads as a subagent rather than as one more tool use", () => {
      items = delegationItems();
      const card = mount().querySelector(".chat-inline-event-delegation");
      expect(card).not.toBeNull();
      expect(card!.querySelector(".chat-inline-event-action")?.textContent).toBe("Subagent");
      expect(card!.querySelector(".chat-inline-event-chip-label")?.textContent).toBe("Count .rs files");
    });

    it("can still be collapsed, and an ordinary tool card stays shut", () => {
      items = delegationItems();
      const el = mount();
      (el.querySelector(".chat-inline-event-delegation .chat-inline-event-expander") as HTMLButtonElement).click();
      expect(el.querySelector(".chat-inline-event-nested")).toBeNull();

      dispose?.();
      host?.remove();
      items = [
        projectionItem({ id: "t", render_class: "tool_card", title: "ToolSearch select:Read", body: "Loaded Read" }),
      ];
      expect(mount().querySelector(".chat-inline-event-body")).toBeNull();
    });
  });
});
