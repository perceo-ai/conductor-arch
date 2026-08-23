// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard for a bug that already shipped once.
 *
 * The composer stacks a rendered markdown preview underneath the textarea and
 * hides the textarea's own glyphs with `color: transparent`. Any other rule
 * that sets `color` on `.chat-input-view` and wins the cascade un-hides those
 * glyphs, and the message renders twice, slightly offset.
 *
 * That is invisible to `tsc` and to every other test, and easy to reintroduce:
 * `.chat-input-view { color: ... }` looks entirely reasonable in isolation. It
 * happened across two separate files here.
 *
 * The invariant asserted is deliberately about specificity rather than load
 * order. Order across five stylesheets is the fragile thing — it is what broke
 * — so the hiding rule is required to out-specify every competitor outright,
 * which holds no matter how the imports are arranged later.
 */

const STYLES = __dirname;

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return entry.endsWith(".css") ? [full] : [];
  });
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Specificity as (ids, classes, elements), packed so it can be compared
 * numerically. Sufficient for these selectors: no ids, no `:where()`, and
 * `:not(x)` counts as the specificity of `x`.
 */
function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/[.:][\w-]+/g) ?? []).filter(
    (t) => !/^::/.test(t) && !/^:(not|is|where)$/.test(t),
  ).length;
  const elements = (selector.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10_000 + classes * 100 + elements;
}

interface ColourRule {
  file: string;
  selector: string;
  specificity: number;
  transparent: boolean;
}

/** Every rule that sets `color` on the `.chat-input-view` element itself. */
function textareaColourRules(): ColourRule[] {
  const out: ColourRule[] = [];
  for (const file of cssFiles(STYLES)) {
    const css = stripComments(readFileSync(file, "utf8"));
    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const body = match[2];
      // `color:` but not `background-color:`, `caret-color:`, `border-color:`.
      if (!/(^|;|\s)color\s*:/.test(body)) continue;
      const value = body.match(/(?:^|;|\s)color\s*:\s*([^;]+)/)?.[1]?.trim() ?? "";
      for (const part of match[1].split(",").map((s) => s.trim())) {
        if (!part.includes(".chat-input-view")) continue;
        // `.chat-input-view text` targets a descendant, not the textarea.
        if (/\.chat-input-view[\w-]*\s+\S/.test(part)) continue;
        out.push({
          file: file.replace(STYLES, "styles"),
          selector: part,
          specificity: specificity(part),
          transparent: value === "transparent",
        });
      }
    }
  }
  return out;
}

describe("composer preview overlay", () => {
  const rules = textareaColourRules();

  it("finds the composer colour rules to compare", () => {
    expect(rules.length).toBeGreaterThan(1);
  });

  it("still hides the textarea's own glyphs while the preview is showing", () => {
    const hiding = rules.filter((r) => r.transparent);
    expect(hiding).toHaveLength(1);
    expect(hiding[0].selector).toContain(".chat-input-view-has-preview");
  });

  it("lets nothing out-specify or tie the rule that hides them", () => {
    const hiding = rules.find((r) => r.transparent)!;
    // A tie is a failure too: ties resolve by source order, which is exactly
    // the fragility this test exists to remove.
    const winners = rules
      .filter((r) => !r.transparent && r.specificity >= hiding.specificity)
      .map((r) => `${r.file}: ${r.selector} (${r.specificity} vs ${hiding.specificity})`);
    expect(winners).toEqual([]);
  });
});
