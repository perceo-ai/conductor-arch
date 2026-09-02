import { describe, expect, it } from "vitest";
import { dragRatio, keyboardResize } from "./resizeHandle";

describe("keyboardResize", () => {
  it("grows and shrinks each edge in its visual direction", () => {
    expect(keyboardResize("right", "ArrowRight", 300, 220, 420, false)).toBe(310);
    expect(keyboardResize("left", "ArrowLeft", 300, 260, 440, false)).toBe(310);
    expect(keyboardResize("top", "ArrowUp", 280, 160, 560, true)).toBe(320);
  });

  it("clamps arrows and supports Home and End", () => {
    expect(keyboardResize("right", "ArrowLeft", 220, 220, 420, false)).toBe(220);
    expect(keyboardResize("top", "Home", 280, 160, 560, false)).toBe(160);
    expect(keyboardResize("left", "End", 300, 260, 440, false)).toBe(440);
    expect(keyboardResize("left", "Enter", 300, 260, 440, false)).toBeUndefined();
  });
});

describe("dragRatio", () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };

  it("computes the fraction along the split's axis", () => {
    expect(dragRatio("row", rect, { x: 200, y: 999 })).toBe(0.5);
    expect(dragRatio("row", rect, { x: 150, y: 999 })).toBe(0.25);
    expect(dragRatio("column", rect, { x: 999, y: 75 })).toBe(0.25);
  });

  it("is unclamped: pointer outside the rect yields a ratio outside 0..1", () => {
    expect(dragRatio("row", rect, { x: 100 - 200, y: 0 })).toBe(-1);
    expect(dragRatio("row", rect, { x: 100 + 400, y: 0 })).toBe(2);
  });

  it("falls back to an even split for a degenerate (zero-size) rect", () => {
    expect(dragRatio("row", { ...rect, width: 0 }, { x: 999, y: 0 })).toBe(0.5);
    expect(dragRatio("column", { ...rect, height: 0 }, { x: 0, y: 999 })).toBe(0.5);
  });
});
