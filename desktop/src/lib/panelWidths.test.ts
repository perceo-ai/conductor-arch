import { describe, expect, it } from "vitest";
import {
  CENTER_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSplitRatio,
  panelDragMax,
  panelMinPx,
} from "./panelWidths";

describe("panelDragMax", () => {
  it("allows the full hard max on a wide window", () => {
    expect(
      panelDragMax({
        viewportWidth: 1600,
        hardMax: SIDEBAR_MAX,
        panelMin: SIDEBAR_MIN,
      }),
    ).toBe(SIDEBAR_MAX);
  });

  it("leaves the workbench its minimum on a narrow window", () => {
    // 800 - 360 (workbench floor) = 440, under the sidebar's own 420 hard max.
    expect(
      panelDragMax({
        viewportWidth: 800,
        hardMax: SIDEBAR_MAX,
        panelMin: SIDEBAR_MIN,
      }),
    ).toBe(SIDEBAR_MAX);
    // 700 - 360 = 340: now the workbench's floor, not the hard max, is binding.
    expect(
      panelDragMax({
        viewportWidth: 700,
        hardMax: SIDEBAR_MAX,
        panelMin: SIDEBAR_MIN,
      }),
    ).toBe(340);
  });

  it("discounts a second fixed column when one is passed", () => {
    // The parameter is optional (the shell has no second fixed column any
    // more) but must still subtract when supplied: 1000 - 300 - 360 = 340.
    expect(
      panelDragMax({
        viewportWidth: 1000,
        otherPanelWidth: 300,
        hardMax: SIDEBAR_MAX,
        panelMin: SIDEBAR_MIN,
      }),
    ).toBe(340);
  });

  it("never drops below the panel's own minimum", () => {
    expect(
      panelDragMax({
        viewportWidth: 500,
        hardMax: SIDEBAR_MAX,
        panelMin: SIDEBAR_MIN,
      }),
    ).toBe(SIDEBAR_MIN);
  });

  it("fits both columns at the smallest supported window", () => {
    // Electron pins the window to 900px wide; sidebar + workbench must fit.
    expect(SIDEBAR_MIN + CENTER_MIN).toBeLessThanOrEqual(900);
  });
});

describe("split sizing", () => {
  it("keeps both children above their minimums", () => {
    // 1000px wide, both sides need 260px: ratio is free between .26 and .74.
    expect(clampSplitRatio(1000, 0.5, 260, 260)).toBeCloseTo(0.5);
    expect(clampSplitRatio(1000, 0.05, 260, 260)).toBeCloseTo(0.26);
    expect(clampSplitRatio(1000, 0.99, 260, 260)).toBeCloseTo(0.74);
  });

  it("splits the difference when the space cannot satisfy both", () => {
    expect(clampSplitRatio(300, 0.9, 260, 260)).toBeCloseTo(0.5);
  });

  it("reports a per-panel minimum with a default", () => {
    expect(panelMinPx("chat")).toBeGreaterThan(0);
    expect(panelMinPx("unknown-panel")).toBeGreaterThan(0);
  });
});
