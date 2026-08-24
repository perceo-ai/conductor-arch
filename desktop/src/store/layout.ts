import { createSignal } from "solid-js";
import { sanitizeLayout, visiblePanelIds, type Layout, type PanelId, type Region } from "@/lib/layout";
import { builtinPreset, type LayoutPreset } from "@/lib/layoutPresets";
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

export const layoutStore = {
  layout,
  activePreset,
  hiddenPanels,
  focusedRegion,
  setFocusedRegion,

  applyLayout(source: LayoutPreset) {
    const preset = normalizedPreset(source);
    setActivePreset(clone(preset));
    setHiddenPanels([...preset.hidden]);
    setLayout(deviceLayout(preset.layout));
  },

  mutate(change: (current: Layout) => Layout) {
    const next = sanitizeLayout(change(clone(layout())));
    setLayout(next);
    setActivePreset((preset) => ({ ...clone(preset), layout: clone(next) }));
    const visible = new Set(visiblePanelIds(next));
    setHiddenPanels(workspacePanels().map((panel) => panel.id).filter((id) => !visible.has(id)));
  },

  resetToCode() {
    this.applyLayout(builtinPreset("code")!);
  },
};
