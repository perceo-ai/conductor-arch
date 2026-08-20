// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyRanges, parseHighlightedHtml } from "./htmlRuns";

describe("parseHighlightedHtml", () => {
  it("returns one unclassed run for plain text", () => {
    expect(parseHighlightedHtml("foo")).toEqual([{ text: "foo", classes: [] }]);
  });

  it("carries the class of a wrapping span onto its run", () => {
    expect(parseHighlightedHtml('<span class="hljs-keyword">const</span>')).toEqual([
      { text: "const", classes: ["hljs-keyword"] },
    ]);
  });

  it("accumulates classes through nested spans", () => {
    const html = '<span class="hljs-string">"a<span class="hljs-subst">b</span>"</span>';
    expect(parseHighlightedHtml(html)).toEqual([
      { text: '"a', classes: ["hljs-string"] },
      { text: "b", classes: ["hljs-string", "hljs-subst"] },
      { text: '"', classes: ["hljs-string"] },
    ]);
  });

  it("decodes entities so run text matches the original source characters", () => {
    expect(parseHighlightedHtml("a &amp;&lt;&gt;&quot;&#39; b")).toEqual([
      { text: "a &<>\"' b", classes: [] },
    ]);
  });
});

describe("applyRanges", () => {
  it("returns the source text unchanged when there are no ranges", () => {
    expect(applyRanges("a &lt; b", [], "w")).toBe("a &lt; b");
  });

  it("wraps the requested character range", () => {
    expect(applyRanges("abcdef", [{ start: 2, end: 4 }], "w")).toBe(
      'ab<span class="w">cd</span>ef',
    );
  });

  it("splits a wrapper at a span boundary so highlight classes survive", () => {
    const html = '<span class="hljs-keyword">const</span> x';
    // Range covers "st x" — the tail of the keyword span plus text outside it.
    expect(applyRanges(html, [{ start: 3, end: 7 }], "w")).toBe(
      '<span class="hljs-keyword">con<span class="w">st</span></span><span class="w"> x</span>',
    );
  });

  it("re-escapes special characters inside and outside wrappers", () => {
    expect(applyRanges("a &lt; b", [{ start: 2, end: 3 }], "w")).toBe(
      'a <span class="w">&lt;</span> b',
    );
  });

  it("applies multiple disjoint ranges", () => {
    expect(applyRanges("abcdef", [{ start: 0, end: 1 }, { start: 4, end: 6 }], "w")).toBe(
      '<span class="w">a</span>bcd<span class="w">ef</span>',
    );
  });
});
