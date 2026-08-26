// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards for two bugs the panel tab strip already shipped.
 *
 * The strip lives in the left region, which drags down to 220px and holds four
 * panels at once. Every tab reserved a permanent 24px lane on its right for a
 * close button it only ever showed on hover, and the tabs split the strip into
 * equal columns rather than sizing to their labels. Together that left roughly
 * 20px for the text: every label rendered as an ellipsis.
 *
 * Reclaiming the lane exposed the second bug. The close button is hidden with
 * `opacity: 0`, which paints nothing but still hit-tests — parked over padding
 * it was harmless, parked over the label it swallowed clicks meant for the tab.
 *
 * Neither is visible to `tsc` and no repo test lays out CSS, so the invariants
 * are asserted against the source: the tab may not reserve a close lane, and a
 * close button that cannot be seen may not be clicked.
 */

const STYLES = __dirname;

/** The stylesheets that style panel tabs, in `base.css` import order. */
function orderedCss(): Array<{ file: string; css: string }> {
  const base = readFileSync(join(STYLES, "base.css"), "utf8");
  return [...base.matchAll(/@import\s+"\.\/([^"]+)"/g)].map((match) => ({
    file: match[1],
    css: readFileSync(join(STYLES, match[1]), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
  }));
}

interface Rule {
  file: string;
  selector: string;
  body: string;
}

/** Every rule whose selector list mentions `token`, in cascade order. */
function rulesFor(token: string): Rule[] {
  const out: Rule[] = [];
  for (const { file, css } of orderedCss()) {
    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = match[1].trim();
      if (selector.includes(token)) out.push({ file, selector, body: match[2] });
    }
  }
  return out;
}

function declaration(body: string, property: string): string | undefined {
  const matches = [...body.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "g"))];
  return matches.at(-1)?.[1].trim();
}

/** Right inset a `padding` or `padding-right` declaration produces, in px. */
function rightInset(value: string, shorthand: boolean): number {
  const parts = value.split(/\s+/);
  const right = shorthand ? (parts[1] ?? parts[0]) : parts[0];
  const px = /^(-?\d+(?:\.\d+)?)px$/.exec(right);
  return px ? Number(px[1]) : 0;
}

describe("panel tab chrome", () => {
  it("never reserves a close-button lane inside the tab", () => {
    const reserved = rulesFor(".workbench-tab")
      .filter((rule) => !rule.selector.includes("workbench-tab-close"))
      .flatMap((rule) => {
        const shorthand = declaration(rule.body, "padding");
        const right = declaration(rule.body, "padding-right");
        const inset = right
          ? rightInset(right, false)
          : shorthand
            ? rightInset(shorthand, true)
            : 0;
        // A tab's own horizontal padding is chrome; anything wider is a lane
        // held open for the close button, which the label pays for.
        return inset > 8 ? [`${rule.file}: ${rule.selector} { …${inset}px right }`] : [];
      });
    expect(reserved).toEqual([]);
  });

  it("keeps the hidden close button out of the hit test", () => {
    const rules = rulesFor(".workbench-tab-close");
    const hidden = rules.filter((rule) => declaration(rule.body, "opacity") === "0");
    const shown = rules.filter((rule) => declaration(rule.body, "opacity") === "1");
    expect(hidden.length).toBeGreaterThan(0);
    expect(shown.length).toBeGreaterThan(0);
    expect(hidden.map((rule) => declaration(rule.body, "pointer-events"))).toEqual(
      hidden.map(() => "none"),
    );
    expect(shown.map((rule) => declaration(rule.body, "pointer-events"))).toEqual(
      shown.map(() => "auto"),
    );
  });

  it("sizes tabs to their labels instead of splitting the strip evenly", () => {
    const flex = rulesFor(".workbench-tab-shell")
      .filter((rule) => !/:(hover|focus-within)/.test(rule.selector))
      .flatMap((rule) => {
        const value = declaration(rule.body, "flex");
        return value ? [value] : [];
      })
      .at(-1);
    // `flex-grow: 0` is the load-bearing half: a tab that may not grow past its
    // content leaves the strip's spare width to the tabs that need it.
    expect(flex).toMatch(/^0\s/);
  });
});
