import { describe, expect, it } from "vitest";
import { checkTone, parsePrReadiness } from "./prReadiness";

describe("PR readiness parsing", () => {
  it("extracts flat check rows from formatted readiness text", () => {
    const view = parsePrReadiness(`PR readiness for workspace demo.
State: OPEN
Merge state: BLOCKED
Review decision: REVIEW_REQUIRED

Attention needed:
- Review decision: REVIEW_REQUIRED

Checks:
- CodeQL: IN_PROGRESS - https://example.test/codeql
- Preflight: SUCCESS - https://example.test/preflight
`);

    expect(view).toMatchObject({
      state: "OPEN",
      mergeState: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
      attention: ["Review decision: REVIEW_REQUIRED"],
    });
    expect(view.checks).toEqual([
      { name: "CodeQL", status: "IN_PROGRESS", detail: "https://example.test/codeql", tone: "running" },
      { name: "Preflight", status: "SUCCESS", detail: "https://example.test/preflight", tone: "passed" },
    ]);
  });

  it("normalizes common check states", () => {
    expect(checkTone("SUCCESS")).toBe("passed");
    expect(checkTone("FAILURE")).toBe("failed");
    expect(checkTone("IN_PROGRESS")).toBe("running");
    expect(checkTone("SKIPPED")).toBe("unknown");
  });
});
