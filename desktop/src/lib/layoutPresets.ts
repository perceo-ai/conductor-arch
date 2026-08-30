import { codeFallback, leaf, split, visiblePanelIds, type Layout, type PanelId } from "./layout";
import { workspacePanels } from "./panelRegistry";

export interface LayoutPreset {
  id: string;
  name: string;
  builtin: boolean;
  layout: Layout;
  hidden: PanelId[];
}

const wideLayout = (): Layout => ({
  version: 2,
  root: split("row", leaf(["chat"]), leaf(["summary", "files", "changes", "checks"], { active: 1 }), 0.72),
});

const reviewLayout = (): Layout => ({
  version: 2,
  root: split(
    "row",
    leaf(["changes", "files"]),
    split("column", leaf(["pr"], { display: "compact" }), leaf(["chat", "checks"]), 0.12),
    0.55,
  ),
});

const watchLayout = (): Layout => ({
  version: 2,
  root: split(
    "column",
    split("row", leaf(["chat"]), leaf(["checks", "processes"]), 0.6),
    leaf(["terminal"], { display: "compact" }),
    0.7,
  ),
});

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Every registered workspace panel not visible in `layout`'s tree. */
function hiddenPanels(layout: Layout): PanelId[] {
  const visible = new Set(visiblePanelIds(layout));
  return workspacePanels()
    .map((panel) => panel.id)
    .filter((id) => !visible.has(id));
}

function builtinPresetOf(id: string, name: string, layout: Layout): LayoutPreset {
  return { id, name, builtin: true, layout, hidden: hiddenPanels(layout) };
}

const builtinSources = deepFreeze<LayoutPreset[]>([
  // The Code tree is owned by layout.ts's CODE_FALLBACK so the default
  // layout and the "Code" preset can never drift apart.
  builtinPresetOf("code", "Code", codeFallback()),
  builtinPresetOf("wide", "Wide", wideLayout()),
  builtinPresetOf("review", "Review", reviewLayout()),
  builtinPresetOf("watch", "Watch", watchLayout()),
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

export function customPresetId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `custom-${crypto.randomUUID()}`;
    }
  } catch {
    // Fall through when the renderer's crypto bridge is unavailable.
  }
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function forkBuiltinPreset(id: string): LayoutPreset {
  const builtin = builtinSources.find((candidate) => candidate.id === id);
  if (!builtin) throw new Error(`Unknown built-in layout preset: ${id}`);
  const fork = clonePreset(builtin);
  return { ...fork, id: customPresetId(), name: `${fork.name} (edited)`, builtin: false };
}

export function presetAfterEdit(preset: LayoutPreset): LayoutPreset {
  return preset.builtin ? forkBuiltinPreset(preset.id) : preset;
}
