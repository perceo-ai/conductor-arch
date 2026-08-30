// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards for bugs the panel tab strip has already shipped.
 *
 * A tab strip can hold four panels in a 220px column. Every tab used to
 * reserve a permanent 24px lane on its right for a close button it only ever
 * showed on hover, and the tabs split the strip into equal columns rather than
 * sizing to their labels. Together that left roughly 20px for the text: every
 * label rendered as an ellipsis.
 *
 * Reclaiming the lane made the close button an absolute overlay on the right
 * edge of its own tab, which brought two more bugs, in opposite directions:
 *
 * 1. Hidden with `opacity: 0`, it painted nothing but still hit-tested, so it
 *    swallowed clicks meant for the label underneath it.
 * 2. Edit mode then made it permanently `opacity: 1; pointer-events: auto`
 *    without taking it out of that overlay, so the right ~21px of every tab
 *    became Hide — in a collapsed 36px rail, nearly every click on a tab
 *    deleted its panel.
 *
 * The invariant that covers both is one rule: a close button is clickable
 * exactly when it is visible, and a *permanently* visible one must not sit on
 * top of its own tab. None of this is visible to `tsc` and no repo test lays
 * out CSS, so it is asserted against the source.
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

  it("keeps the hidden close button out of the hit test, and the shown one in it", () => {
    const rules = rulesFor(".workbench-tab-close");
    const hidden = rules.filter((rule) => declaration(rule.body, "opacity") === "0");
    const shown = rules.filter((rule) => declaration(rule.body, "opacity") === "1");
    expect(hidden.length).toBeGreaterThan(0);
    expect(shown.length).toBeGreaterThan(0);
    // Invisible: unclickable, or it eats the label's clicks.
    expect(hidden.map((rule) => declaration(rule.body, "pointer-events"))).toEqual(
      hidden.map(() => "none"),
    );
    // Visible: clickable. Not "must say `auto`" — only "must not say `none`",
    // so a rule may inherit the hit test from a lower-specificity one instead
    // of restating it.
    expect(
      shown
        .filter((rule) => declaration(rule.body, "pointer-events") === "none")
        .map((rule) => `${rule.file}: ${rule.selector}`),
    ).toEqual([]);
  });

  it("never leaves a permanently visible close button overlaying its own tab", () => {
    // The base rule parks the button absolutely over the right edge of the tab
    // it belongs to. Revealing it on hover is fine — the pointer is already
    // there and the tab is already the thing being aimed at. Revealing it for
    // a whole mode is not: it silently converts the last 21px of every tab
    // into Hide. Such a rule has to leave the overlay as well as light it up.
    const permanent = rulesFor(".workbench-tab-close")
      .filter((rule) => declaration(rule.body, "opacity") === "1")
      .filter((rule) => !/:(hover|focus-within|focus-visible|active)/.test(rule.selector));
    expect(permanent.length).toBeGreaterThan(0);
    expect(
      permanent
        .filter((rule) => declaration(rule.body, "position") !== "static")
        .map((rule) => `${rule.file}: ${rule.selector} { …not position: static }`),
    ).toEqual([]);
  });

  it("advertises the grab cursor only where dragging is possible", () => {
    // Dragging a tab exists only in edit mode — outside it `PanelLeaf` attaches
    // no pointerdown handler at all — so an unscoped `cursor: grab` promises a
    // gesture that does nothing in the mode users spend all their time in.
    const grabbable = rulesFor(".workbench-tab")
      .filter((rule) => declaration(rule.body, "cursor") === "grab")
      .map((rule) => `${rule.file}: ${rule.selector}`);
    expect(grabbable.length).toBeGreaterThan(0);
    expect(grabbable.filter((selector) => !selector.includes(".workbench-editing"))).toEqual([]);
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
