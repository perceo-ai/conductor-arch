// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isDisplayableTimelineItem } from "./timeline";
import type { ArchcarProjectionItem } from "@/bridge/protocol";

// Text bubbles (assistant + reasoning) render only when finalized; command and
// other cards render live so a running command shows immediately.
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

  it("hides streaming reasoning text", () => {
    expect(
      isDisplayableTimelineItem(item({ render_class: "reasoning_card", stream_state: "streaming" })),
    ).toBe(false);
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
});
