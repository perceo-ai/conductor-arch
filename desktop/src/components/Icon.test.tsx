// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import Icon, { type IconName } from "./Icon";

/**
 * These icons were hand-redrawn approximations of Lucide once, and the set read
 * as amateurish for a reason that is invisible one icon at a time: the glyphs
 * disagreed with each other. Rings were r=9 where Lucide uses r=10, the search
 * lens was r=7, frames mixed rx=1 with rx=2, `square` was inset 6 while every
 * other frame was inset 3, `play` bled to x=21, and one dot was filled where
 * everything else was stroked. Each looked fine alone; a row of them wobbled.
 *
 * So the invariant asserted is the shared vocabulary rather than the artwork:
 * one ring radius, one frame, one stroke weight, one canvas. A freehand icon
 * pasted in later fails here instead of shipping.
 */

// Kept in sync with the IconName union by the completeness test below.
const NAMES: IconName[] = [
  "alert", "alert-circle", "arrow-left", "arrow-right", "arrow-up",
  "arrow-up-circle", "arrow-down", "arrow-down-circle", "bolt", "brain",
  "circle-dashed", "circle-dot", "circle-help", "circle-slash", "circle-x",
  "git-branch", "loader-circle", "chevron-down", "chevron-left",
  "chevron-right", "chevron-up", "cloud", "external", "file", "file-code",
  "file-text", "folder", "git-merge", "git-compare", "git-pull-request",
  "history", "layout-dashboard", "monitor", "panel-left", "panel-right",
  "paperclip", "pencil", "play", "plus", "refresh", "search", "circle-check",
  "send", "sidebar", "settings", "square", "terminal", "wrench", "x",
];

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

function mountAll() {
  host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => NAMES.map((name) => <Icon name={name} title={name} />) as never, host);
  return [...host.querySelectorAll("svg")];
}

/** The icon a shape belongs to, for a failure message that names the culprit. */
function ownerOf(el: Element): string {
  return el.closest("svg")?.querySelector("title")?.textContent ?? "?";
}

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

describe("Icon", () => {
  it("renders every name in the union", () => {
    const svgs = mountAll();
    expect(svgs).toHaveLength(NAMES.length);
    const empty = svgs.filter((s) => s.querySelectorAll("path,circle,rect,line").length === 0);
    expect(empty.map(ownerOf)).toEqual([]);
  });

  it("draws every outer ring at the same radius", () => {
    mountAll();
    // A ring is a circle concentric with the canvas and large enough to be the
    // icon's outer shape; `settings`' r=3 hub and `circle-dot`'s r=1 pip are not.
    const rings = [...host!.querySelectorAll("circle")].filter(
      (c) => c.getAttribute("cx") === "12" && c.getAttribute("cy") === "12" && Number(c.getAttribute("r")) >= 5,
    );
    expect(rings.length).toBeGreaterThan(5);
    const odd = rings.filter((c) => c.getAttribute("r") !== "10").map((c) => `${ownerOf(c)}: r=${c.getAttribute("r")}`);
    expect(odd).toEqual([]);
  });

  it("draws every square frame at the same inset and corner radius", () => {
    mountAll();
    // Square rects are frames (`square`, the panel rails). Oblong ones are
    // artwork — a monitor bezel, a dashboard tile — and set their own size.
    const frames = [...host!.querySelectorAll("rect")].filter(
      (r) => r.getAttribute("width") === r.getAttribute("height"),
    );
    expect(frames.length).toBeGreaterThan(2);
    const odd = frames
      .filter((r) => ["width", "x", "y", "rx"].some((a, i) => r.getAttribute(a) !== ["18", "3", "3", "2"][i]))
      .map((r) => `${ownerOf(r)}: ${r.getAttribute("width")}@${r.getAttribute("x")},${r.getAttribute("y")} rx=${r.getAttribute("rx")}`);
    expect(odd).toEqual([]);
  });

  it("strokes every mark and fills none of them", () => {
    mountAll();
    // A filled shape next to stroked ones is the one mark in a row that looks
    // bold, which is what a per-icon `fill="currentColor"` quietly produces.
    const filled = [...host!.querySelectorAll("path,circle,rect,line")]
      .filter((el) => {
        const fill = el.getAttribute("fill");
        return (fill !== null && fill !== "none") || el.getAttribute("stroke") !== null || el.getAttribute("stroke-width") !== null;
      })
      .map((el) => `${ownerOf(el)}: ${el.tagName}`);
    expect(filled).toEqual([]);
  });

  it("keeps every absolute move inside the 24x24 canvas", () => {
    mountAll();
    const strays: string[] = [];
    for (const el of host!.querySelectorAll("path")) {
      // Only the absolute `M`/`L` anchors: relative segments are deltas and an
      // arc's radii and flags are not positions, so neither is bounded by the
      // canvas. The anchors are enough to catch a glyph drawn off-grid.
      for (const [, x, y] of (el.getAttribute("d") ?? "").matchAll(/[ML]\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g)) {
        for (const n of [x, y]) {
          if (Number(n) < 0 || Number(n) > 24) strays.push(`${ownerOf(el)}: ${n}`);
        }
      }
    }
    expect(strays).toEqual([]);
  });
});
