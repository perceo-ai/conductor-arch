// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import DotGridLoader from "./DotGridLoader";
import { DEFAULT_DOT_GRID } from "@/lib/dotGrid";

// The wave arithmetic is covered in lib/dotGrid.test.ts. What this file checks
// is the part that arithmetic cannot: that the component actually puts dots in
// the DOM with their delays attached. A loader that computes a perfect wave and
// renders an empty div still ships as a blank space where the loader should be.

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

function mount(el: () => unknown) {
  host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el as never, host);
  return host;
}

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

describe("DotGridLoader", () => {
  it("renders one dot per grid cell", () => {
    const el = mount(() => <DotGridLoader />);
    const dots = el.querySelectorAll(".dot-grid-loader-dot");
    expect(dots).toHaveLength(DEFAULT_DOT_GRID.rows * DEFAULT_DOT_GRID.cols);
  });

  it("gives every dot an animation-delay, so the wave is not all one phase", () => {
    const el = mount(() => <DotGridLoader />);
    const delays = [...el.querySelectorAll<HTMLElement>(".dot-grid-loader-dot")].map(
      (d) => d.style.animationDelay,
    );
    expect(delays.every((d) => d.endsWith("ms"))).toBe(true);
    // If phase offsets were dropped, every dot would carry the same delay and
    // the grid would blink in unison rather than flow.
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it("sets the column count from the spec so the grid is not a single row", () => {
    const el = mount(() => <DotGridLoader />);
    const grid = el.querySelector<HTMLElement>(".dot-grid-loader-grid");
    expect(grid?.style.gridTemplateColumns).toContain(`repeat(${DEFAULT_DOT_GRID.cols}`);
  });

  it("announces itself with the phase label", () => {
    const el = mount(() => <DotGridLoader label="Generating" />);
    const status = el.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(el.querySelector(".dot-grid-loader-label")?.textContent).toBe("Generating");
  });

  it("hides the decorative grid from assistive tech", () => {
    const el = mount(() => <DotGridLoader />);
    expect(el.querySelector(".dot-grid-loader-grid")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("honours a custom grid spec", () => {
    const spec = { ...DEFAULT_DOT_GRID, rows: 2, cols: 4 };
    const el = mount(() => <DotGridLoader spec={spec} />);
    expect(el.querySelectorAll(".dot-grid-loader-dot")).toHaveLength(8);
  });
});
