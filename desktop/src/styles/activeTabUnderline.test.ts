// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard for a bug that already shipped once.
 *
 * The active tab on the dashboard, the history filters and the chat/file tab
 * rails is underlined in the accent colour. The motion pass draws that
 * underline as an `::after` bar so it can scale out from the tab's centre;
 * before that pass existed, the earlier passes drew the same underline as an
 * accent `border-bottom` (and, in one place, an inset `box-shadow`).
 *
 * Both survived. The `::after` bar is inset 6px on each side and the border is
 * full width, so the active tab rendered a stepped double underline — the
 * border poking out past both ends of the bar.
 *
 * `tsc` cannot see this and no other test renders CSS, so the invariant is
 * asserted directly: exactly one mechanism may paint an active tab's bottom
 * edge, and it is the `::after` bar.
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

interface EdgeRule {
  file: string;
  selector: string;
  declaration: string;
}

/**
 * Every declaration that paints the bottom edge of an active tab element
 * itself. A transparent border is not paint — the base tab keeps one to hold
 * its height steady — and neither is `box-shadow: none`.
 */
function bottomEdgePaint(): EdgeRule[] {
  const out: EdgeRule[] = [];
  for (const file of cssFiles(STYLES)) {
    const css = stripComments(readFileSync(file, "utf8"));
    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const painted = [...match[2].matchAll(/(?:^|;|\s)(border-bottom[\w-]*|box-shadow)\s*:\s*([^;]+)/g)]
        .filter(([, , value]) => !/^(none|0|transparent)$/.test(value.trim()))
        .filter(([, property, value]) => property !== "box-shadow" || /inset/.test(value))
        .filter(([, property, value]) => !/^border-bottom(-color)?$/.test(property) || !/transparent/.test(value));
      if (painted.length === 0) continue;
      for (const part of match[1].split(",").map((s) => s.trim())) {
        if (!part.includes("ws-tab-active")) continue;
        // `.ws-tab-active .ws-tab-label` targets a child, not the tab.
        if (/\.ws-tab-active[\w-]*\s+\S/.test(part)) continue;
        // The `::after` bar is the one sanctioned underline.
        if (part.includes("::after")) continue;
        for (const [, property, value] of painted) {
          out.push({
            file: file.replace(STYLES, "styles"),
            selector: part,
            declaration: `${property}: ${value.trim()}`,
          });
        }
      }
    }
  }
  return out;
}

/** The `::after` bar rules that switch the underline on for an active tab. */
function underlineBarSelectors(): string[] {
  const out: string[] = [];
  for (const file of cssFiles(STYLES)) {
    const css = stripComments(readFileSync(file, "utf8"));
    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/transform\s*:\s*scaleX\(1\)/.test(match[2])) continue;
      for (const part of match[1].split(",").map((s) => s.trim())) {
        if (part.includes("ws-tab-active") && part.includes("::after")) out.push(part);
      }
    }
  }
  return out;
}

describe("active tab underline", () => {
  it("still draws the underline as a scaling ::after bar", () => {
    expect(underlineBarSelectors().length).toBeGreaterThan(0);
  });

  it("draws it exactly once — nothing else paints an active tab's bottom edge", () => {
    const duplicates = bottomEdgePaint().map(
      (r) => `${r.file}: ${r.selector} { ${r.declaration} }`,
    );
    expect(duplicates).toEqual([]);
  });
});
