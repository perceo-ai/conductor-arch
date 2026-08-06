// @vitest-environment node
import { describe, expect, it } from "vitest";
import { computeDiffRows } from "./diff";

const SAMPLE = [
  "diff --git a/f.ts b/f.ts",
  "--- a/f.ts",
  "+++ b/f.ts",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+two-changed",
  "+added",
  " three",
].join("\n");

describe("computeDiffRows", () => {
  it("assigns old/new line numbers from the hunk header", () => {
    const code = computeDiffRows(SAMPLE).filter((r) =>
      ["added", "removed", "context"].includes(r.kind),
    );
    expect(code[0]).toMatchObject({ kind: "context", oldNo: 1, newNo: 1 }); // one
    expect(code[1]).toMatchObject({ kind: "removed", oldNo: 2, newNo: null }); // two
    expect(code[2]).toMatchObject({ kind: "added", oldNo: null, newNo: 2 }); // two-changed
    expect(code[3]).toMatchObject({ kind: "added", oldNo: null, newNo: 3 }); // added
    expect(code[4]).toMatchObject({ kind: "context", oldNo: 3, newNo: 4 }); // three
  });

  it("marks meta and hunk rows with no line numbers", () => {
    const rows = computeDiffRows(SAMPLE);
    expect(rows.find((r) => r.kind === "hunk")).toMatchObject({ oldNo: null, newNo: null });
    expect(rows.filter((r) => r.kind === "meta").every((r) => r.oldNo === null)).toBe(true);
  });

  it("resets counters on a second hunk", () => {
    const text = [
      "@@ -10,2 +20,2 @@",
      " a",
      "+b",
      "@@ -50,1 +80,1 @@",
      " c",
    ].join("\n");
    const rows = computeDiffRows(text).filter((r) => r.kind === "context" || r.kind === "added");
    expect(rows[0]).toMatchObject({ oldNo: 10, newNo: 20 }); // a
    expect(rows[1]).toMatchObject({ oldNo: null, newNo: 21 }); // b
    expect(rows[2]).toMatchObject({ oldNo: 50, newNo: 80 }); // c
  });
});
