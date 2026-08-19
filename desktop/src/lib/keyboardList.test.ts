// @vitest-environment node
import { describe, expect, it } from "vitest";
import { nextListIndex } from "./keyboardList";

describe("nextListIndex", () => {
  it("moves through list items with wraparound", () => {
    expect(nextListIndex(0, 3, "next")).toBe(1);
    expect(nextListIndex(2, 3, "next")).toBe(0);
    expect(nextListIndex(0, 3, "previous")).toBe(2);
  });

  it("jumps to first and last items", () => {
    expect(nextListIndex(2, 5, "first")).toBe(0);
    expect(nextListIndex(2, 5, "last")).toBe(4);
  });

  it("keeps an empty list at zero", () => {
    expect(nextListIndex(4, 0, "next")).toBe(0);
  });
});
