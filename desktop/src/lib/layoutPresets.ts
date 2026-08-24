import { REGION_DEFAULT_SIZES } from "./panelWidths";
import type { Layout, PanelId, Region, Stack } from "./layout";

export interface LayoutPreset {
  id: string;
  name: string;
  builtin: boolean;
  layout: Layout;
  hidden: PanelId[];
}

const emptyStack = (region: Region): Stack => ({
  panels: [],
  strips: [],
  docks: [],
  active: 0,
  size: REGION_DEFAULT_SIZES[region],
  collapsed: false,
});

function presetLayout(regions: Partial<Record<Region, Partial<Stack>>>): Layout {
  const stack = (region: Region): Stack => ({ ...emptyStack(region), ...regions[region], panels: [...(regions[region]?.panels ?? [])], strips: [...(regions[region]?.strips ?? [])], docks: [...(regions[region]?.docks ?? [])] });
  return { version: 1, regions: { left: stack("left"), center: stack("center"), bottom: stack("bottom"), right: stack("right") } };
}

const deadPanels = ["todos", "checkpoints", "processes", "timeline", "context"];

export const BUILTIN_PRESETS: LayoutPreset[] = [
  {
    id: "code",
    name: "Code",
    builtin: true,
    layout: presetLayout({
      center: { panels: ["chat"] },
      right: { strips: ["pr"], panels: ["summary", "files", "changes", "checks"], docks: ["terminal"], active: 2 },
    }),
    hidden: deadPanels,
  },
  {
    id: "wide",
    name: "Wide",
    builtin: true,
    layout: presetLayout({
      left: { panels: ["files"] },
      center: { panels: ["chat"] },
      bottom: { docks: ["terminal"] },
      right: { strips: ["pr"], panels: ["summary", "changes", "checks"] },
    }),
    hidden: deadPanels,
  },
  {
    id: "review",
    name: "Review",
    builtin: true,
    layout: presetLayout({
      left: { panels: ["files"] },
      center: { panels: ["changes"] },
      bottom: { docks: ["terminal"] },
      right: { strips: ["pr"], panels: ["checks", "summary", "chat"] },
    }),
    hidden: deadPanels,
  },
  {
    id: "watch",
    name: "Watch",
    builtin: true,
    layout: presetLayout({
      center: { docks: ["terminal"] },
      bottom: { panels: ["chat"] },
      right: { panels: ["summary", "checks"] },
    }),
    hidden: ["pr", "files", "changes", ...deadPanels],
  },
];

function clonePreset(preset: LayoutPreset): LayoutPreset {
  return structuredClone(preset);
}

export function builtinPreset(id: string): LayoutPreset | undefined {
  return BUILTIN_PRESETS.find((preset) => preset.id === id);
}

export function mergePresets(presets: LayoutPreset[]): LayoutPreset[] {
  const builtins = new Set(BUILTIN_PRESETS.map((preset) => preset.id));
  const users = presets.filter((preset) => !builtins.has(preset.id));
  return [...BUILTIN_PRESETS, ...users];
}

export function forkBuiltinPreset(id: string): LayoutPreset {
  const builtin = builtinPreset(id);
  if (!builtin) throw new Error(`Unknown built-in layout preset: ${id}`);
  const fork = clonePreset(builtin);
  return { ...fork, id: `custom-${crypto.randomUUID()}`, name: `${fork.name} (edited)`, builtin: false };
}

export function presetAfterEdit(preset: LayoutPreset): LayoutPreset {
  return preset.builtin ? forkBuiltinPreset(preset.id) : preset;
}
