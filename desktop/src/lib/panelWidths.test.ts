import { describe, expect, it } from "vitest";
import {
  BOTTOM_MAX,
  BOTTOM_MIN,
  CENTER_MIN,
  LEFT_MAX,
  LEFT_MIN,
  REGION_DEFAULT_SIZES,
  RIGHT_MAX,
  RIGHT_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampRegionSize,
  panelDragMax,
} from "./panelWidths";

describe("panelDragMax", () => {
  it("allows the full hard max on a wide window", () => {
    expect(
      panelDragMax({
        viewportWidth: 1600,
        otherPanelWidth: RIGHT_MIN,
        hardMax: SIDEBAR_MAX,
        panelMin: SIDEBAR_MIN,
      }),
    ).toBe(SIDEBAR_MAX);
  });

  it("leaves the centre column its minimum on a narrow window", () => {
    // 1000 - 300 (right panel) - 360 (centre) = 340 left for the sidebar.
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
        viewportWidth: 900,
        otherPanelWidth: 440,
        hardMax: RIGHT_MAX,
        panelMin: RIGHT_MIN,
      }),
    ).toBe(RIGHT_MIN);
  });

  it("fits every column at the smallest supported window", () => {
    // Electron pins the window to 900px wide; the three minimums must fit.
    expect(SIDEBAR_MIN + CENTER_MIN + RIGHT_MIN).toBeLessThanOrEqual(900);
  });
});

describe("region sizes", () => {
  it("defines defaults and clamps each resizable workbench region", () => {
    expect(REGION_DEFAULT_SIZES).toEqual({ left: 260, center: 0, right: 300, bottom: 280 });
    expect(clampRegionSize("left", 0)).toBe(LEFT_MIN);
    expect(clampRegionSize("left", 999)).toBe(LEFT_MAX);
    expect(clampRegionSize("right", 0)).toBe(RIGHT_MIN);
    expect(clampRegionSize("right", 999)).toBe(RIGHT_MAX);
    expect(clampRegionSize("bottom", 0)).toBe(BOTTOM_MIN);
    expect(clampRegionSize("bottom", 999)).toBe(BOTTOM_MAX);
    expect(clampRegionSize("center", 123)).toBe(0);
  });
});
