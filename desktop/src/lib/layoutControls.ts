import { panelDescriptor } from "./panelRegistry";
import type { PanelId } from "./layout";
import type { IconName } from "@/components/Icon";

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
