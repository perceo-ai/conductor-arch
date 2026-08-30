// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";

import { leaf, type LayoutLeaf } from "@/lib/layout";
import { registerPanel, unregisterPanel } from "@/lib/panelRegistry";
import { layoutStore } from "@/store/layout";
import PanelLeaf from "./PanelLeaf";

const FIRST_ID = "panel-leaf-first";
const SECOND_ID = "panel-leaf-second";
let dispose: (() => void) | undefined;

beforeEach(() => {
  registerPanel({
    id: FIRST_ID,
    title: "First",
    icon: "file-text",
    kind: "tab",
    component: () => <div>First panel body</div>,
    requiresWorkspace: true,
  });
  registerPanel({
    id: SECOND_ID,
    title: "Second",
    icon: "file-text",
    kind: "tab",
    component: () => <div>Second panel body</div>,
    requiresWorkspace: true,
  });
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  unregisterPanel(FIRST_ID);
  unregisterPanel(SECOND_ID);
  layoutStore.resetToCode();
});

/**
 * Renders the leaf the store is actually holding, so an `activatePanel` that
 * rewrites the tree reaches the component the way it does in the app.
 */
function mount(node: LayoutLeaf) {
  const host = document.createElement("div");
  document.body.append(host);
  layoutStore.applyLayout({
    id: "panel-leaf-test",
    name: "Panel leaf test",
    builtin: false,
    layout: { version: 2, root: node },
    hidden: [],
  });
  const live = () => layoutStore.layout().root as LayoutLeaf;
  dispose = render(() => <PanelLeaf leaf={live()} workspace="demo" />, host);
  return host;
}

/** For states `sanitizeLayout` deliberately repairs away, e.g. all-collapsed. */
function mountStatic(node: LayoutLeaf) {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <PanelLeaf leaf={node} workspace="demo" />, host);
  return host;
}

describe("PanelLeaf", () => {
  it("exposes the DOM contract the drag layer measures", () => {
    const node = leaf([FIRST_ID, SECOND_ID], { id: "leaf-under-test" });
    const host = mount(node);

    expect(host.querySelector("[data-leaf-id]")?.getAttribute("data-leaf-id")).toBe("leaf-under-test");
    const bar = host.querySelector("[data-leaf-id] [data-tab-bar]");
    expect(bar).toBeTruthy();
    expect([...bar!.querySelectorAll("[data-tab-index]")].map((tab) => tab.getAttribute("data-tab-index")))
      .toEqual(["0", "1"]);
  });

  it("remounts the active panel component when its identity changes", async () => {
    const node = leaf([FIRST_ID, SECOND_ID], { id: "leaf-remount" });
    const host = mount(node);

    expect(host.querySelector("[role='tabpanel']")?.textContent).toContain("First panel body");

    layoutStore.activatePanel(SECOND_ID);
    await Promise.resolve();

    const panel = host.querySelector<HTMLElement>("[role='tabpanel']");
    expect(panel?.dataset.panelId).toBe(SECOND_ID);
    expect(panel?.textContent).toContain("Second panel body");
    expect(panel?.textContent).not.toContain("First panel body");
  });

  it("renders a compact single-panel leaf without a tab bar", () => {
    const node = leaf([FIRST_ID], { id: "leaf-compact", display: "compact" });
    const host = mount(node);

    expect(host.querySelector("[data-tab-bar]")).toBeNull();
    expect(host.querySelector("[data-panel-id]")?.textContent).toContain("First panel body");
  });

  it("keeps the tab bar and drops the body when collapsed", () => {
    const node = leaf([FIRST_ID], { id: "leaf-collapsed", display: "compact", collapsed: true });
    const host = mountStatic(node);

    expect(host.querySelector("[data-tab-bar]")).toBeTruthy();
    expect(host.querySelector(".workbench-panel-body")).toBeNull();
  });
});
