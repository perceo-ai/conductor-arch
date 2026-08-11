import { describe, expect, it } from "vitest";
import { applyIndent } from "./indent";

describe("applyIndent", () => {
  it("inserts two spaces at a collapsed caret", () => {
    const r = applyIndent("abc", 1, 1, false);
    expect(r.text).toBe("a  bc");
    expect(r.selStart).toBe(3);
    expect(r.selEnd).toBe(3);
  });

  it("indents every line touched by a selection", () => {
    const text = "one\ntwo\nthree";
    // selection covers part of line 1 through part of line 2
    const r = applyIndent(text, 1, 5, false);
    expect(r.text).toBe("  one\n  two\nthree");
  });

  it("dedents leading spaces up to one unit", () => {
    const text = "    deep\n  shallow";
    const r = applyIndent(text, 0, text.length, true);
    expect(r.text).toBe("  deep\nshallow");
  });

  it("dedent is a no-op on lines with no leading whitespace", () => {
    const text = "flush\nleft";
    const r = applyIndent(text, 0, text.length, true);
    expect(r.text).toBe(text);
  });

  it("keeps selection anchored to the first line when dedenting", () => {
    const text = "  x";
    const r = applyIndent(text, 2, 3, true);
    expect(r.text).toBe("x");
    expect(r.selStart).toBe(0);
    expect(r.selEnd).toBe(1);
  });
});
