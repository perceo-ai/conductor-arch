// @vitest-environment node
import { describe, expect, it } from "vitest";
import { diffWords, pairChangedRuns } from "./wordDiff";

describe("diffWords", () => {
  it("returns null for identical lines", () => {
    expect(diffWords("const a = 1", "const a = 1")).toBeNull();
  });

  it("marks only the token that changed", () => {
    expect(diffWords("const a = 1", "const b = 1")).toEqual({
      removed: [{ start: 6, end: 7 }],
      added: [{ start: 6, end: 7 }],
    });
  });

  it("marks an insertion on the new side only", () => {
    expect(diffWords("a c", "a b c")).toEqual({
      removed: [],
      added: [{ start: 2, end: 4 }],
    });
  });

  it("merges adjacent changed tokens into one range", () => {
    const res = diffWords("call(one, two)", "call(three, four)");
    expect(res?.removed).toEqual([
      { start: 5, end: 8 },
      { start: 10, end: 13 },
    ]);
    expect(res?.added).toEqual([
      { start: 5, end: 10 },
      { start: 12, end: 16 },
    ]);
  });

  it("marks changed leading whitespace", () => {
    expect(diffWords("  x", "    x")).toEqual({
      removed: [{ start: 0, end: 2 }],
      added: [{ start: 0, end: 4 }],
    });
  });

  it("returns null when the lines share no tokens, leaving the row tint to say it", () => {
    expect(diffWords("aaa", "zzz")).toBeNull();
  });

  it("returns null for very long lines rather than running a quadratic compare", () => {
    const a = "x ".repeat(600);
    expect(diffWords(a, a + "y")).toBeNull();
  });
});

describe("pairChangedRuns", () => {
  it("pairs equal-length removed/added runs positionally", () => {
    expect(pairChangedRuns(2, 2)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it("declines to pair runs of different lengths", () => {
    expect(pairChangedRuns(1, 3)).toEqual([]);
  });

  it("returns nothing when either side is empty", () => {
    expect(pairChangedRuns(0, 2)).toEqual([]);
    expect(pairChangedRuns(2, 0)).toEqual([]);
  });
});
