// @vitest-environment node
import { describe, expect, it } from "vitest";
import { editorGutter } from "./editorGutter";

describe("editorGutter", () => {
  it("gives an empty buffer one line", () => {
    expect(editorGutter("", 0)).toEqual({ count: 1, digits: 2, activeLine: 1 });
  });

  it("counts lines and locates the caret's line", () => {
    expect(editorGutter("a\nb\nc", 3)).toMatchObject({ count: 3, activeLine: 2 });
  });

  it("counts the empty line after a trailing newline", () => {
    expect(editorGutter("a\n", 0)).toMatchObject({ count: 2 });
  });

  it("puts the caret on the line it starts, not the one it ends", () => {
    // Offset 2 is the newline itself — still line 1.
    expect(editorGutter("ab\ncd", 2)).toMatchObject({ activeLine: 1 });
    expect(editorGutter("ab\ncd", 3)).toMatchObject({ activeLine: 2 });
  });

  it("clamps a caret past the end of the buffer", () => {
    expect(editorGutter("a\nb", 999)).toMatchObject({ activeLine: 2 });
  });

  it("never renders a gutter narrower than two digits", () => {
    expect(editorGutter("a", 0).digits).toBe(2);
  });

  it("widens the gutter to the line count", () => {
    expect(editorGutter("x\n".repeat(120), 0).digits).toBe(3);
  });
});
