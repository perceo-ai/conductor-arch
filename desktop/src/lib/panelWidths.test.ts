import { describe, expect, it } from "vitest";
import { CENTER_MIN, RIGHT_MAX, RIGHT_MIN, SIDEBAR_MAX, SIDEBAR_MIN, panelDragMax } from "./panelWidths";

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
