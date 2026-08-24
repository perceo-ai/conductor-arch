import { describe, expect, it } from "vitest";
import { keyboardResize } from "./resizeHandle";

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
