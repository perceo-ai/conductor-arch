export const PRODUCT_RIGHT_PANEL_TABS = [
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
  { id: "checks", label: "Checks" },
] as const;

export type RightPanelTab = (typeof PRODUCT_RIGHT_PANEL_TABS)[number]["id"];

const LABELS = new Map<string, string>(
  PRODUCT_RIGHT_PANEL_TABS.map((tab) => [tab.id, tab.label]),
);

export function normalizeRightPanelTab(tab: string): RightPanelTab {
  return LABELS.has(tab) ? (tab as RightPanelTab) : "changes";
}

export function rightPanelTabLabel(tab: string): string {
  return LABELS.get(tab) ?? "Changes";
}
