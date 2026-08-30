import { createSignal } from "solid-js";
import { send } from "@/bridge/client";
import type { ArchcarResponse, LayoutPresetRecord } from "@/bridge/protocol";
import { sanitizeLayout, sanitizeLayoutResult, type Layout } from "@/lib/layout";
import {
  BUILTIN_PRESETS,
  builtinPreset,
  customPresetId,
  mergePresets,
  type LayoutPreset,
} from "@/lib/layoutPresets";
import { daemonChangedSince, daemonEpoch } from "./daemonEpoch";
import { layoutStore } from "./layout";
import { prefsStore } from "./prefs";
import { toastsStore } from "./toasts";

const BUILTIN_IDS = new Set(BUILTIN_PRESETS.map((preset) => preset.id));
const SAVE_DELAY_MS = 250;

const [presets, setPresets] = createSignal<LayoutPreset[]>(mergePresets([]));
const [loaded, setLoaded] = createSignal(false);
const [projectDefaultId, setProjectDefaultId] = createSignal<string>();
let pendingSave: ReturnType<typeof setTimeout> | undefined;
let pendingPreset: LayoutPreset | undefined;
/** Which daemon the queued edit was made against. See `scheduleSave`. */
let pendingEpoch = 0;
let lastRepository: string | undefined;

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * A preset is shared across clients, so it carries the tree and nothing
 * device-local. Ratios travel with it — they are proportions, not pixels — and
 * sanitising is the only normalisation left now that region sizes are gone.
 */
function portableLayout(source: Layout): Layout {
  return sanitizeLayout(clone(source));
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
    // `sanitizeLayout` never throws — it substitutes the Code tree — so the
    // catch below only covers a `JSON.parse` failure. The case the spec
    // actually predicts (a v1 record, or a v2 record too broken to repair)
    // came back looking like a clean load: no toast, and the first subsequent
    // edit persisted the Code tree over the stored record. `replaced` is the
    // sanitiser reporting that substitution.
    const result = sanitizeLayoutResult(JSON.parse(record.layout_json));
    layout = result.layout;
    invalid = result.replaced;
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
  pendingEpoch = 0;
}

function responseError(response: ArchcarResponse, expected: string): never {
  if (response.type === "error") throw new Error(response.message);
  throw new Error(`Expected ${expected}, received ${response.type}`);
}

/**
 * Save a preset to the daemon it belongs to.
 *
 * `epoch` is the connection the edit was made against. It defaults to the
 * current one for an immediate save, but a debounced save has to pass the epoch
 * captured when the edit was queued — otherwise a switch inside the debounce
 * window sends the old daemon's layout to the new one.
 */
async function persist(preset: LayoutPreset, epoch: number = daemonEpoch()): Promise<boolean> {
  const snapshot = clone(preset);
  // Refuse before sending, not just when the reply lands: the write itself
  // would otherwise be addressed to the wrong daemon.
  if (daemonChangedSince(epoch)) return false;
  try {
    const response = await send({ type: "save_layout_preset", preset: toRecord(snapshot) });
    // The write landed on whichever daemon was active when it was sent. Folding
    // its echo into the list after a switch would add a preset the current
    // daemon does not have.
    if (daemonChangedSince(epoch)) return false;
    if (response.type !== "layout_preset_saved") responseError(response, "layout_preset_saved");
    const saved = fromRecord(response.preset).preset;
    replaceUserPreset(saved);
    return true;
  } catch (error) {
    if (daemonChangedSince(epoch)) return false;
    // Retry against the same daemon the edit was for. After a switch this is a
    // no-op rather than a write of the old daemon's layout to the new one.
    const retry = () => void persist(snapshot, epoch);
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
  // The epoch of the daemon this edit was made against, captured now rather
  // than when the timer fires. Switching within the debounce window would
  // otherwise send daemon A's layout to daemon B: `persist` would capture B's
  // epoch at fire time and see nothing stale about it.
  pendingEpoch = daemonEpoch();
  pendingSave = setTimeout(() => {
    pendingSave = undefined;
    const queued = pendingPreset;
    const epoch = pendingEpoch;
    pendingPreset = undefined;
    if (queued) void persist(queued, epoch);
  }, SAVE_DELAY_MS);
}

async function flushPendingSave(): Promise<boolean> {
  if (!pendingPreset) return true;
  if (pendingSave !== undefined) clearTimeout(pendingSave);
  pendingSave = undefined;
  const queued = pendingPreset;
  const epoch = pendingEpoch;
  pendingPreset = undefined;
  return persist(queued, epoch);
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
    // Presets belong to a daemon. If the user switches while this is in
    // flight, applying the answer would show the old daemon's layouts under
    // the new one — and persist one of their ids as the new daemon's
    // selection.
    const epoch = daemonEpoch();
    const [listResponse, settingsResponse] = await Promise.all([
      send({ type: "list_layout_presets" }),
      repository ? send({ type: "get_settings", repository }) : Promise.resolve(undefined),
    ]);
    if (daemonChangedSince(epoch)) return;
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
    const epoch = daemonEpoch();
    try {
      const response = await send({ type: "delete_layout_preset", id });
      if (daemonChangedSince(epoch)) return false;
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
    const epoch = daemonEpoch();
    try {
      if (!(await flushPendingSave())) return false;
      const response = await send({
        type: "set_project_default_preset",
        repository,
        preset_id: presetId,
      });
      if (daemonChangedSince(epoch)) return false;
      if (response.type !== "ack") responseError(response, "ack");
      setProjectDefaultId(presetId);
      return true;
    } catch (error) {
      if (daemonChangedSince(epoch)) return false;
      toastsStore.error(`Could not set project layout: ${(error as Error).message}`);
      return false;
    }
  },

  cancelPendingSave,
};
