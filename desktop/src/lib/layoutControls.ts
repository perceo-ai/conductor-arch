import { panelDescriptor } from "./panelRegistry";
import type { PanelId } from "./layout";
import type { IconName } from "@/components/Icon";
import type { LayoutPreset } from "./layoutPresets";

export interface HiddenPanelControl {
  id: PanelId;
  title: string;
  icon: IconName;
  ariaLabel: string;
}

export function hiddenPanelControls(ids: PanelId[]): HiddenPanelControl[] {
  return ids.flatMap((id) => {
    const panel = panelDescriptor(id);
    return panel ? [{ id, title: panel.title, icon: panel.icon, ariaLabel: `Restore ${panel.title}` }] : [];
  });
}

export function layoutPresetControls(
  presets: LayoutPreset[],
  activeId: string,
  defaultId?: string,
) {
  return presets.map((preset) => ({
    id: preset.id,
    label: `${preset.name}${preset.builtin ? " (built-in, locked)" : ""}${preset.id === defaultId ? " (project default)" : ""}`,
    active: preset.id === activeId,
    locked: preset.builtin,
  }));
}
