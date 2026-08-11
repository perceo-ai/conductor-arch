import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("empty query matches everything with score 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("returns null when a query char is missing", () => {
    expect(fuzzyScore("xyz", "dashboard")).toBeNull();
  });

  it("matches a subsequence in order", () => {
    expect(fuzzyScore("dsh", "dashboard")).not.toBeNull();
    // out-of-order fails
    expect(fuzzyScore("hsd", "dashboard")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("REV", "review")).not.toBeNull();
  });

  it("ranks a contiguous prefix above a scattered match", () => {
    const contiguous = fuzzyScore("term", "terminal")!;
    const scattered = fuzzyScore("term", "the recent modal")!;
    expect(contiguous).toBeLessThan(scattered);
  });
});
