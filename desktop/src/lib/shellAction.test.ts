import { describe, expect, it } from "vitest";
import { shellFailureMessage } from "./shellAction";

describe("shellFailureMessage", () => {
  it("returns null when the call succeeded", () => {
    expect(shellFailureMessage("Open", { ok: true })).toBeNull();
  });

  it("includes the reason the main process gave", () => {
    expect(
      shellFailureMessage("Open", {
        ok: false,
        error: "Archductor is connected to the daemon at devbox:7420",
      }),
    ).toBe("Open failed: Archductor is connected to the daemon at devbox:7420");
  });

  it("still reports a failure with no reason attached", () => {
    expect(shellFailureMessage("Open", { ok: false })).toBe("Open failed.");
    expect(shellFailureMessage("Open", { ok: false, error: "  " })).toBe("Open failed.");
  });

  it("treats a missing result as a failure rather than a success", () => {
    expect(shellFailureMessage("Open", undefined)).toBe("Open failed.");
  });
});
