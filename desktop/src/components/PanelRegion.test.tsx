// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";

import { builtinPreset } from "@/lib/layoutPresets";
import { registerPanel, unregisterPanel } from "@/lib/panelRegistry";
import { layoutStore } from "@/store/layout";
import PanelRegion from "./PanelRegion";

const FIRST_ID = "panel-region-first";
const SECOND_ID = "panel-region-second";
let dispose: (() => void) | undefined;

beforeEach(() => {
  registerPanel({
    id: FIRST_ID,
    title: "First",
    icon: "file-text",
    kind: "tab",
    component: () => <div>First panel body</div>,
    regions: ["center"],
    defaultRegion: "center",
    requiresWorkspace: true,
  });
  registerPanel({
    id: SECOND_ID,
    title: "Second",
    icon: "file-text",
    kind: "tab",
    component: () => <div>Second panel body</div>,
    regions: ["center"],
    defaultRegion: "center",
    requiresWorkspace: true,
  });

  const preset = builtinPreset("code")!;
  preset.id = "panel-region-test";
  preset.name = "Panel region test";
  preset.builtin = false;
  preset.layout.regions.center.panels = [FIRST_ID, SECOND_ID];
  preset.layout.regions.center.active = 0;
  layoutStore.applyLayout(preset);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  unregisterPanel(FIRST_ID);
  unregisterPanel(SECOND_ID);
  layoutStore.resetToCode();
});

describe("PanelRegion", () => {
  it("remounts the active panel component when its identity changes", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    dispose = render(() => <PanelRegion workspace="demo" region="center" />, host);

    expect(host.querySelector("[role='tabpanel']")?.textContent).toContain("First panel body");

    layoutStore.activatePanel(SECOND_ID);
    await Promise.resolve();

    const panel = host.querySelector<HTMLElement>("[role='tabpanel']");
    expect(panel?.dataset.panelId).toBe(SECOND_ID);
    expect(panel?.textContent).toContain("Second panel body");
    expect(panel?.textContent).not.toContain("First panel body");
  });
});
