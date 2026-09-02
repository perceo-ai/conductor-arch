// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isDisplayableTimelineItem, showsNewChatIntro, withoutPlanSource } from "./timeline";
import type { ArchcarProjectionItem } from "@/bridge/protocol";

// Assistant text renders only when finalized; reasoning, command, and other
// activity cards render live so the agent's current state is visible.
function item(overrides: Partial<ArchcarProjectionItem>): ArchcarProjectionItem {
  return {
    id: "x",
    sequence: 1,
    render_class: "assistant_chat",
    role_label: "assistant",
    title: "",
    body: "hi",
    status: "running",
    stream_state: "streaming",
    ...overrides,
  };
}

describe("isDisplayableTimelineItem", () => {
  it("hides streaming assistant text", () => {
    expect(
      isDisplayableTimelineItem(item({ render_class: "assistant_chat", stream_state: "streaming" })),
    ).toBe(false);
  });

  it("shows finalized assistant text", () => {
    expect(
      isDisplayableTimelineItem(item({ render_class: "assistant_chat", stream_state: "complete" })),
    ).toBe(true);
  });

  it("shows streaming reasoning text", () => {
    expect(
      isDisplayableTimelineItem(item({ render_class: "reasoning_card", stream_state: "streaming" })),
    ).toBe(true);
  });

  it("shows command card while running", () => {
    expect(
      isDisplayableTimelineItem(
        item({ render_class: "command_card", status: "running", stream_state: "streaming" }),
      ),
    ).toBe(true);
  });

  it("shows command card when complete", () => {
    expect(
      isDisplayableTimelineItem(
        item({ render_class: "command_card", status: "complete", stream_state: "complete" }),
      ),
    ).toBe(true);
  });

  it("shows user input", () => {
    expect(
      isDisplayableTimelineItem(item({ render_class: "user_chat", stream_state: "complete" })),
    ).toBe(true);
  });

  it("shows provider error cards", () => {
    expect(
      isDisplayableTimelineItem(
        item({ render_class: "error_card", status: "failed", stream_state: "complete" }),
      ),
    ).toBe(true);
  });
});

/**
 * A codex plan is not a new message — `raise_codex_plan_approval` lifts its
 * `detail` straight out of the newest `assistant_chat` item. Rendering both the
 * card and the message it was lifted from shows the same plan twice.
 */
describe("withoutPlanSource", () => {
  const PLAN = "## Step one\n\nDo the thing.";

  it("drops the assistant message a pending plan was lifted from", () => {
    const items = [
      item({ id: "a", body: "sure, planning", stream_state: "complete" }),
      item({ id: "b", body: PLAN, stream_state: "complete" }),
    ];
    expect(withoutPlanSource(items, PLAN).map((i) => i.id)).toEqual(["a"]);
  });

  it("keeps everything when no plan is pending", () => {
    const items = [item({ id: "b", body: PLAN, stream_state: "complete" })];
    expect(withoutPlanSource(items, null).map((i) => i.id)).toEqual(["b"]);
  });

  it("keeps a plan whose text the agent never said as a message", () => {
    // Claude's plan comes from the ExitPlanMode tool input, not from the
    // transcript, so usually nothing matches and nothing may be dropped.
    const items = [item({ id: "a", body: "on it", stream_state: "complete" })];
    expect(withoutPlanSource(items, PLAN).map((i) => i.id)).toEqual(["a"]);
  });

  it("drops only the copy the card was lifted from", () => {
    // If the agent genuinely repeated itself, the earlier message is still part
    // of the conversation — only the newest one became the card.
    const items = [
      item({ id: "a", body: PLAN, stream_state: "complete" }),
      item({ id: "b", body: "then", stream_state: "complete" }),
      item({ id: "c", body: PLAN, stream_state: "complete" }),
    ];
    expect(withoutPlanSource(items, PLAN).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("matches across incidental whitespace", () => {
    const items = [item({ id: "b", body: `${PLAN}\n`, stream_state: "complete" })];
    expect(withoutPlanSource(items, `  ${PLAN}  `)).toEqual([]);
  });

  it("never drops a user message that happens to quote the plan", () => {
    const items = [item({ id: "u", render_class: "user_chat", body: PLAN, stream_state: "complete" })];
    expect(withoutPlanSource(items, PLAN).map((i) => i.id)).toEqual(["u"]);
  });
});

describe("showsNewChatIntro", () => {
  it("shows on a genuinely empty thread", () => {
    expect(showsNewChatIntro(0, false)).toBe(true);
  });

  it("stays hidden once there are messages", () => {
    expect(showsNewChatIntro(2, false)).toBe(false);
  });

  it("stays hidden when the only message became the plan card", () => {
    // withoutPlanSource empties the list here; a chat awaiting plan approval is
    // the opposite of a new one.
    expect(showsNewChatIntro(0, true)).toBe(false);
  });
});
