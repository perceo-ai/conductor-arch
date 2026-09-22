import { describe, expect, it } from "vitest";
import { chatTabLabel } from "./chatTabLabel";

describe("chatTabLabel", () => {
  it("shows the agent-supplied chat title", () => {
    expect(chatTabLabel("Billing Webhook Retries", 0)).toBe("Billing Webhook Retries");
  });

  it("falls back to the position while the title is still a placeholder", () => {
    expect(chatTabLabel("New chat", 0)).toBe("Chat 1");
    expect(chatTabLabel("new chat", 2)).toBe("Chat 3");
    expect(chatTabLabel("", 1)).toBe("Chat 2");
    expect(chatTabLabel("   ", 1)).toBe("Chat 2");
    expect(chatTabLabel(undefined, 1)).toBe("Chat 2");
  });

  it("trims a real title", () => {
    expect(chatTabLabel("  Fix Chat Rename  ", 0)).toBe("Fix Chat Rename");
  });
});
