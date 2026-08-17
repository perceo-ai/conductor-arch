import { describe, expect, it } from "vitest";
import { composerPrimaryAction } from "./composerPrimaryAction";

describe("composerPrimaryAction", () => {
  it("uses the default send action while idle", () => {
    expect(composerPrimaryAction(false)).toBe("send");
  });

  it("switches to interrupt while the chat is running", () => {
    expect(composerPrimaryAction(true)).toBe("interrupt");
  });
});
