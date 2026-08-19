import { describe, expect, it } from "vitest";
import {
  contextPreamble,
  formatPlan,
  formatTranscript,
  planPickKey,
  togglePick,
  transcriptChipDetail,
  transcriptPickKey,
  type NewChatContextPick,
} from "./newChatContext";

function pick(key: string, body = "body"): NewChatContextPick {
  return { key, kind: "plan", label: key, body };
}

describe("formatTranscript", () => {
  it("labels user and agent turns and drops empty bodies", () => {
    const text = formatTranscript("Fix login", [
      { role: "user", content: "  fix login  ", created_at: "t1" },
      { role: "agent", content: "Done.", created_at: "t2" },
      { role: "agent", content: "   ", created_at: "t3" },
    ]);
    expect(text).toBe("### Chat transcript — Fix login\n\nUser: fix login\nAgent: Done.");
  });
});

describe("formatPlan", () => {
  it("names the plan and its path", () => {
    expect(formatPlan("Checkout rewrite", ".context/plans/checkout.md", "Step 1\n")).toBe(
      "### Plan — Checkout rewrite (.context/plans/checkout.md)\n\nStep 1",
    );
  });
});

describe("contextPreamble", () => {
  it("is empty when nothing is attached", () => {
    expect(contextPreamble([])).toBe("");
  });

  it("is empty when every pick is blank", () => {
    expect(contextPreamble([pick("plan:a", "   ")])).toBe("");
  });

  it("joins attached blocks under one heading", () => {
    const text = contextPreamble([pick("plan:a", "alpha"), pick("plan:b", "beta")]);
    expect(text).toContain("Context attached from Archductor");
    expect(text).toContain("alpha\n\nbeta");
  });
});

describe("togglePick", () => {
  it("adds an unselected pick at the end", () => {
    expect(togglePick([pick("plan:a")], pick("plan:b")).map((p) => p.key)).toEqual([
      "plan:a",
      "plan:b",
    ]);
  });

  it("removes an already-selected pick", () => {
    expect(togglePick([pick("plan:a"), pick("plan:b")], pick("plan:a")).map((p) => p.key)).toEqual([
      "plan:b",
    ]);
  });
});

describe("keys and labels", () => {
  it("keeps transcript and plan keys distinct", () => {
    expect(transcriptPickKey(7)).toBe("transcript:7");
    expect(planPickKey(".context/plans/a.md")).toBe("plan:.context/plans/a.md");
  });

  it("singularises the message count", () => {
    expect(transcriptChipDetail(1)).toBe("1 message");
    expect(transcriptChipDetail(4)).toBe("4 messages");
  });
});
