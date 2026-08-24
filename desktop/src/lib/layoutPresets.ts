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

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const builtinSources = deepFreeze<LayoutPreset[]>([
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
]);

/** Immutable built-in sources. Use builtinPreset for an editable copy. */
export const BUILTIN_PRESETS: readonly LayoutPreset[] = builtinSources;

function clonePreset(preset: LayoutPreset): LayoutPreset {
  return structuredClone(preset);
}

export function builtinPreset(id: string): LayoutPreset | undefined {
  const preset = builtinSources.find((candidate) => candidate.id === id);
  return preset ? clonePreset(preset) : undefined;
}

export function mergePresets(presets: LayoutPreset[]): LayoutPreset[] {
  const builtins = new Set(builtinSources.map((preset) => preset.id.toLowerCase()));
  const users = presets
    .filter((preset) => !builtins.has(preset.id.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
  return [...builtinSources.map(clonePreset), ...users];
}

export function forkBuiltinPreset(id: string): LayoutPreset {
  const builtin = builtinSources.find((candidate) => candidate.id === id);
  if (!builtin) throw new Error(`Unknown built-in layout preset: ${id}`);
  const fork = clonePreset(builtin);
  return { ...fork, id: `custom-${crypto.randomUUID()}`, name: `${fork.name} (edited)`, builtin: false };
}

export function presetAfterEdit(preset: LayoutPreset): LayoutPreset {
  return preset.builtin ? forkBuiltinPreset(preset.id) : preset;
}
