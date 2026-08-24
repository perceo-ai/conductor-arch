import { createSignal } from "solid-js";
import { send } from "@/bridge/client";
import type { ArchcarResponse, LayoutPresetRecord } from "@/bridge/protocol";
import { sanitizeLayout, type Layout, type Region } from "@/lib/layout";
import {
  BUILTIN_PRESETS,
  builtinPreset,
  customPresetId,
  mergePresets,
  type LayoutPreset,
} from "@/lib/layoutPresets";
import { REGION_DEFAULT_SIZES } from "@/lib/panelWidths";
import { layoutStore } from "./layout";
import { prefsStore } from "./prefs";
import { toastsStore } from "./toasts";

const REGIONS: Region[] = ["left", "center", "bottom", "right"];
const BUILTIN_IDS = new Set(BUILTIN_PRESETS.map((preset) => preset.id));
const SAVE_DELAY_MS = 250;

const [presets, setPresets] = createSignal<LayoutPreset[]>(mergePresets([]));
const [loaded, setLoaded] = createSignal(false);
const [projectDefaultId, setProjectDefaultId] = createSignal<string>();
let pendingSave: ReturnType<typeof setTimeout> | undefined;
let pendingPreset: LayoutPreset | undefined;
let lastRepository: string | undefined;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function portableLayout(source: Layout): Layout {
  const layout = sanitizeLayout(clone(source));
  for (const region of REGIONS) {
    layout.regions[region].size = REGION_DEFAULT_SIZES[region];
    layout.regions[region].collapsed = false;
  }
  return layout;
}

function toRecord(preset: LayoutPreset): LayoutPresetRecord {
  return {
    id: preset.id,
    name: preset.name,
    builtin: false,
    layout_json: JSON.stringify(portableLayout(preset.layout)),
    hidden_json: JSON.stringify(preset.hidden),
    created_at: "",
    updated_at: "",
  };
}

function fromRecord(record: LayoutPresetRecord): { preset: LayoutPreset; invalid: boolean } {
  let invalid = false;
  let layout: Layout;
  let hidden: string[];
  try {
    layout = sanitizeLayout(JSON.parse(record.layout_json));
  } catch {
    invalid = true;
    layout = builtinPreset("code")!.layout;
  }
  try {
    const parsed = JSON.parse(record.hidden_json) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) throw new Error();
    hidden = parsed;
  } catch {
    invalid = true;
    hidden = builtinPreset("code")!.hidden;
  }
  return {
    preset: {
      id: record.id,
      name: record.name,
      builtin: false,
      layout: clone(layout),
      hidden: [...hidden],
    },
    invalid,
  };
}

function defaultPresetFromToml(toml: string): string | undefined {
  let inView = false;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(/^\[([^\]]+)]$/)?.[1];
    if (section) {
      inView = section === "customization.view";
      continue;
    }
    if (!inView || line.startsWith("#")) continue;
    const match = line.match(/^default_layout_preset\s*=\s*"((?:\\.|[^"\\])*)"/);
    if (match) return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return undefined;
}

function replaceUserPreset(preset: LayoutPreset) {
  const users = presets().filter((candidate) => !candidate.builtin && candidate.id !== preset.id);
  setPresets(mergePresets([...users, clone(preset)]));
}

function cancelPendingSave() {
  if (pendingSave !== undefined) clearTimeout(pendingSave);
  pendingSave = undefined;
  pendingPreset = undefined;
}

function responseError(response: ArchcarResponse, expected: string): never {
  if (response.type === "error") throw new Error(response.message);
  throw new Error(`Expected ${expected}, received ${response.type}`);
}

async function persist(preset: LayoutPreset): Promise<boolean> {
  const snapshot = clone(preset);
  try {
    const response = await send({ type: "save_layout_preset", preset: toRecord(snapshot) });
    if (response.type !== "layout_preset_saved") responseError(response, "layout_preset_saved");
    const saved = fromRecord(response.preset).preset;
    replaceUserPreset(saved);
    return true;
  } catch (error) {
    const retry = () => void persist(snapshot);
    toastsStore.push(
      `Layout kept locally, but could not sync: ${(error as Error).message}`,
      "error",
      8000,
      { label: "Retry", run: retry },
    );
    return false;
  }
}

function scheduleSave(preset: LayoutPreset) {
  cancelPendingSave();
  replaceUserPreset(preset);
  prefsStore.setActivePresetId(preset.id);
  pendingPreset = clone(preset);
  pendingSave = setTimeout(() => {
    pendingSave = undefined;
    const queued = pendingPreset;
    pendingPreset = undefined;
    if (queued) void persist(queued);
  }, SAVE_DELAY_MS);
}

async function flushPendingSave(): Promise<boolean> {
  if (!pendingPreset) return true;
  if (pendingSave !== undefined) clearTimeout(pendingSave);
  pendingSave = undefined;
  const queued = pendingPreset;
  pendingPreset = undefined;
  return persist(queued);
}

layoutStore.onEdited(scheduleSave);

export const layoutPresetsStore = {
  presets,
  loaded,
  projectDefaultId,
  activeId: () => layoutStore.activePreset().id,
  activePreset: () => presets().find((preset) => preset.id === layoutStore.activePreset().id),
  lastRepository: () => lastRepository,

  async load(repository?: string): Promise<void> {
    cancelPendingSave();
    lastRepository = repository;
    const [listResponse, settingsResponse] = await Promise.all([
      send({ type: "list_layout_presets" }),
      repository ? send({ type: "get_settings", repository }) : Promise.resolve(undefined),
    ]);
    if (listResponse.type !== "layout_presets") responseError(listResponse, "layout_presets");

    let invalid = false;
    const users = listResponse.presets
      .filter((record) => !BUILTIN_IDS.has(record.id.toLowerCase()))
      .map((record) => {
        const parsed = fromRecord(record);
        invalid ||= parsed.invalid;
        return parsed.preset;
      });
    const next = mergePresets(users);
    setPresets(next);
    if (invalid) toastsStore.error("One saved layout was invalid and was restored with Code.");

    if (settingsResponse && settingsResponse.type !== "settings") {
      responseError(settingsResponse, "settings");
    }
    const projectDefault =
      settingsResponse?.type === "settings"
        ? defaultPresetFromToml(settingsResponse.toml)
        : undefined;
    setProjectDefaultId(projectDefault);
    const local = next.find((preset) => preset.id === prefsStore.state.activePresetId);
    const project = next.find((preset) => preset.id === projectDefault);
    const selected = local ?? project ?? next.find((preset) => preset.id === "code")!;
    layoutStore.applyLayout(selected);
    prefsStore.setActivePresetId(selected.id);
    setLoaded(true);
  },

  select(id: string): boolean {
    const preset = presets().find((candidate) => candidate.id === id);
    if (!preset) return false;
    cancelPendingSave();
    layoutStore.applyLayout(preset);
    prefsStore.setActivePresetId(preset.id);
    return true;
  },

  async saveWorkingCopy(name?: string): Promise<boolean> {
    cancelPendingSave();
    const current = layoutStore.activePreset();
    const copy: LayoutPreset = {
      ...clone(current),
      id: customPresetId(),
      name: name?.trim() || `${current.name} copy`,
      builtin: false,
    };
    replaceUserPreset(copy);
    layoutStore.applyLayout(copy);
    prefsStore.setActivePresetId(copy.id);
    return persist(copy);
  },

  async rename(name: string): Promise<boolean> {
    const current = layoutStore.activePreset();
    const nextName = name.trim();
    if (current.builtin || !nextName) return false;
    cancelPendingSave();
    const renamed = { ...clone(current), name: nextName };
    replaceUserPreset(renamed);
    layoutStore.applyLayout(renamed);
    return persist(renamed);
  },

  async delete(id: string): Promise<boolean> {
    const target = presets().find((preset) => preset.id === id);
    if (!target || target.builtin) return false;
    cancelPendingSave();
    try {
      const response = await send({ type: "delete_layout_preset", id });
      if (response.type !== "ack") responseError(response, "ack");
      setPresets(presets().filter((preset) => preset.id !== id));
      if (layoutStore.activePreset().id === id) {
        const fallback =
          presets().find((preset) => preset.id === projectDefaultId()) ??
          presets().find((preset) => preset.id === "code")!;
        layoutStore.applyLayout(fallback);
        prefsStore.setActivePresetId(fallback.id);
      }
      return true;
    } catch (error) {
      toastsStore.error(`Could not delete layout: ${(error as Error).message}`);
      return false;
    }
  },

  async setProjectDefault(repository: string, presetId: string): Promise<boolean> {
    if (!presets().some((preset) => preset.id === presetId)) return false;
    try {
      if (!(await flushPendingSave())) return false;
      const response = await send({
        type: "set_project_default_preset",
        repository,
        preset_id: presetId,
      });
      if (response.type !== "ack") responseError(response, "ack");
      setProjectDefaultId(presetId);
      return true;
    } catch (error) {
      toastsStore.error(`Could not set project layout: ${(error as Error).message}`);
      return false;
    }
  },

  cancelPendingSave,
};
