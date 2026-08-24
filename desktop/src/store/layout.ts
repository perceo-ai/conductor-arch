import { createSignal } from "solid-js";
import {
  activatePanel as activateLayoutPanel,
  collapseRegion as collapseLayoutRegion,
  hidePanel as hideLayoutPanel,
  movePanel as moveLayoutPanel,
  resizeRegion as resizeLayoutRegion,
  sanitizeLayout,
  showPanel as showLayoutPanel,
  visiblePanelIds,
  type Layout,
  type PanelId,
  type Region,
} from "@/lib/layout";
import { builtinPreset, presetAfterEdit, type LayoutPreset } from "@/lib/layoutPresets";
import { workspacePanels } from "@/lib/panelRegistry";
import { prefsStore } from "./prefs";

const REGIONS: Region[] = ["left", "center", "right", "bottom"];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deviceLayout(source: Layout): Layout {
  const layout = sanitizeLayout(clone(source));
  for (const region of REGIONS) {
    layout.regions[region].size = prefsStore.state.regionSizes[region];
    layout.regions[region].collapsed =
      region !== "center" && prefsStore.state.collapsedRegions.includes(region);
  }
  return layout;
}

function normalizedPreset(source: LayoutPreset): LayoutPreset {
  const preset = clone(source);
  preset.layout = sanitizeLayout(preset.layout);
  const visible = new Set(visiblePanelIds(preset.layout));
  const known = new Set(workspacePanels().map((panel) => panel.id));
  preset.hidden = [...new Set(preset.hidden)].filter((id) => known.has(id) && !visible.has(id));
  for (const id of known) {
    if (!visible.has(id) && !preset.hidden.includes(id)) preset.hidden.push(id);
  }
  return preset;
}

const initial = normalizedPreset(builtinPreset("code")!);
const [layout, setLayout] = createSignal<Layout>(deviceLayout(initial.layout));
const [activePreset, setActivePreset] = createSignal<LayoutPreset>(clone(initial));
const [hiddenPanels, setHiddenPanels] = createSignal<PanelId[]>([...initial.hidden]);
const [focusedRegion, setFocusedRegion] = createSignal<Region>("center");
let onEdited: ((preset: LayoutPreset) => void) | undefined;

export const layoutStore = {
  layout,
  activePreset,
  hiddenPanels,
  focusedRegion,
  setFocusedRegion,

  onEdited(listener: ((preset: LayoutPreset) => void) | undefined) {
    onEdited = listener;
  },

  focusPanel(id: PanelId) {
    const escaped = id.replace(/[\\']/g, "\\$&");
    queueMicrotask(() => {
      if (typeof document !== "undefined") {
        document.querySelector<HTMLElement>(`[data-panel-id='${escaped}']`)?.focus();
      }
    });
  },

  cyclePanel(delta: 1 | -1): PanelId | undefined {
    const tabs = REGIONS.flatMap((region) => layout().regions[region].panels);
    if (tabs.length === 0) return undefined;
    const currentStack = layout().regions[focusedRegion()];
    const current = currentStack.panels[currentStack.active];
    const currentIndex = Math.max(0, tabs.indexOf(current));
    const id = tabs[(currentIndex + delta + tabs.length) % tabs.length];
    const region = REGIONS.find((candidate) => layout().regions[candidate].panels.includes(id));
    if (!region) return undefined;
    this.activatePanel(id);
    setFocusedRegion(region);
    this.focusPanel(id);
    return id;
  },

  applyLayout(source: LayoutPreset) {
    const preset = normalizedPreset(source);
    setActivePreset(clone(preset));
    setHiddenPanels([...preset.hidden]);
    setLayout(deviceLayout(preset.layout));
  },

  mutate(change: (current: Layout) => Layout) {
    const current = clone(layout());
    const next = sanitizeLayout(change(current));
    if (JSON.stringify(next) === JSON.stringify(layout())) return false;
    const working = presetAfterEdit(clone(activePreset()));
    setLayout(next);
    const visible = new Set(visiblePanelIds(next));
    const hidden = workspacePanels().map((panel) => panel.id).filter((id) => !visible.has(id));
    setHiddenPanels(hidden);
    const edited = { ...working, layout: clone(next), hidden: [...hidden] };
    setActivePreset(edited);
    onEdited?.(clone(edited));
    return true;
  },

  activatePanel(id: PanelId) {
    if (!visiblePanelIds(layout()).includes(id)) {
      this.mutate((current) => activateLayoutPanel(current, id));
      return;
    }
    setLayout(activateLayoutPanel(layout(), id));
  },

  movePanel(id: PanelId, region: Region, index: number) {
    this.mutate((current) => moveLayoutPanel(current, id, region, index));
  },

  hidePanel(id: PanelId) {
    this.mutate((current) => hideLayoutPanel(current, id));
  },

  showPanel(id: PanelId, region?: Region) {
    this.mutate((current) => showLayoutPanel(current, id, region));
  },

  resizeRegion(region: Region, size: number) {
    const next = resizeLayoutRegion(layout(), region, size);
    setLayout(next);
    prefsStore.setRegionSize(region, next.regions[region].size);
  },

  collapseRegion(region: Region, collapsed: boolean) {
    const next = collapseLayoutRegion(layout(), region, collapsed);
    setLayout(next);
    if (next.regions[region].collapsed === collapsed) {
      prefsStore.setRegionCollapsed(region, collapsed);
    }
  },

  resetToCode() {
    this.applyLayout(builtinPreset("code")!);
  },
};
