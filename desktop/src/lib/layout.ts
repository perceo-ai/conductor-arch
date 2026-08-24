import { clampRegionSize, REGION_DEFAULT_SIZES } from "./panelWidths";
import { panelDescriptor, registeredPanels } from "./panelRegistry";

export type Region = "left" | "center" | "bottom" | "right";
export type PanelId = string;
export type PanelKind = "tab" | "strip" | "dock";

export interface Stack {
  panels: PanelId[];
  strips: PanelId[];
  docks: PanelId[];
  active: number;
  size: number;
  collapsed: boolean;
}

export interface Layout {
  version: 1;
  regions: Record<Region, Stack>;
}

export interface DropTarget {
  region: Region;
  index: number;
}

export interface DropTargetRegion {
  region: Region;
  allowed: boolean;
  tabs: Array<{ left: number; width: number }>;
}

const REGIONS: Region[] = ["left", "center", "bottom", "right"];

function cloneStack(stack: Stack): Stack {
  return { ...stack, panels: [...stack.panels], strips: [...stack.strips], docks: [...stack.docks] };
}

function cloneLayout(layout: Layout): Layout {
  return {
    ...layout,
    regions: {
      left: cloneStack(layout.regions.left),
      center: cloneStack(layout.regions.center),
      bottom: cloneStack(layout.regions.bottom),
      right: cloneStack(layout.regions.right),
    },
  };
}

function listFor(stack: Stack, kind: PanelKind): PanelId[] {
  return kind === "tab" ? stack.panels : kind === "strip" ? stack.strips : stack.docks;
}

function normalize(stack: Stack): Stack {
  const active = stack.panels.length === 0 ? 0 : Math.max(0, Math.min(stack.active, stack.panels.length - 1));
  return active === stack.active ? stack : { ...stack, active };
}

function normalizeLayout(layout: Layout): Layout {
  for (const region of REGIONS) layout.regions[region] = normalize(layout.regions[region]);
  return layout;
}

function centerHasContent(layout: Layout): boolean {
  const center = layout.regions.center;
  return center.panels.length > 0 || center.docks.length > 0;
}

function removePanel(layout: Layout, id: PanelId) {
  for (const region of REGIONS) {
    const stack = layout.regions[region];
    stack.panels = stack.panels.filter((panel) => panel !== id);
    stack.strips = stack.strips.filter((panel) => panel !== id);
    stack.docks = stack.docks.filter((panel) => panel !== id);
  }
}

function panelLocation(layout: Layout, id: PanelId): Region | undefined {
  return REGIONS.find((region) => {
    const stack = layout.regions[region];
    return stack.panels.includes(id) || stack.strips.includes(id) || stack.docks.includes(id);
  });
}

export function visiblePanelIds(layout: Layout): PanelId[] {
  return REGIONS.flatMap((region) => {
    const stack = layout.regions[region];
    return [...stack.strips, ...stack.panels, ...stack.docks];
  });
}

export function movePanel(layout: Layout, id: PanelId, toRegion: Region, toIndex: number): Layout {
  const descriptor = panelDescriptor(id);
  if (!descriptor || !descriptor.regions.includes(toRegion)) return layout;
  const next = cloneLayout(layout);
  removePanel(next, id);
  const target = listFor(next.regions[toRegion], descriptor.kind);
  target.splice(Math.max(0, Math.min(toIndex, target.length)), 0, id);
  normalizeLayout(next);
  return centerHasContent(next) ? next : layout;
}

export function hidePanel(layout: Layout, id: PanelId): Layout {
  if (!panelLocation(layout, id)) return layout;
  const next = cloneLayout(layout);
  removePanel(next, id);
  normalizeLayout(next);
  return centerHasContent(next) ? next : layout;
}

export function showPanel(layout: Layout, id: PanelId, region?: Region): Layout {
  if (panelLocation(layout, id)) return layout;
  const descriptor = panelDescriptor(id);
  const targetRegion = region ?? descriptor?.defaultRegion;
  if (!descriptor || !targetRegion || !descriptor.regions.includes(targetRegion)) return layout;
  const next = cloneLayout(layout);
  listFor(next.regions[targetRegion], descriptor.kind).push(id);
  return normalizeLayout(next);
}

export function activatePanel(layout: Layout, id: PanelId): Layout {
  const descriptor = panelDescriptor(id);
  if (!descriptor) return layout;
  const shown = showPanel(layout, id);
  const region = panelLocation(shown, id);
  if (!region) return layout;
  const next = cloneLayout(shown);
  const stack = next.regions[region];
  stack.collapsed = false;
  if (descriptor.kind === "tab") stack.active = stack.panels.indexOf(id);
  return normalizeLayout(next);
}

export function resizeRegion(layout: Layout, region: Region, size: number): Layout {
  const next = cloneLayout(layout);
  next.regions[region].size = clampRegionSize(region, size);
  return next;
}

export function collapseRegion(layout: Layout, region: Region, collapsed: boolean): Layout {
  const next = cloneLayout(layout);
  next.regions[region].collapsed = collapsed;
  return next;
}

export function sanitizeLayout(layout: Layout): Layout {
  const next = cloneLayout(layout);
  const seen = new Set<PanelId>();
  for (const region of REGIONS) {
    const stack = next.regions[region];
    for (const kind of ["tab", "strip", "dock"] as const) {
      const list = listFor(stack, kind);
      const kept = list.filter((id) => {
        const descriptor = panelDescriptor(id);
        if (!descriptor || descriptor.kind !== kind || seen.has(id) || !descriptor.regions.includes(region)) return false;
        seen.add(id);
        return true;
      });
      if (kind === "tab") stack.panels = kept;
      else if (kind === "strip") stack.strips = kept;
      else stack.docks = kept;
    }
    stack.size = clampRegionSize(region, stack.size || REGION_DEFAULT_SIZES[region]);
  }
  if (!centerHasContent(next)) {
    const fallback = registeredPanels().find((panel) => panel.defaultRegion === "center" && !seen.has(panel.id));
    if (fallback) {
      listFor(next.regions.center, fallback.kind).push(fallback.id);
      seen.add(fallback.id);
    }
  }
  return normalizeLayout(next);
}

export function dropTarget(regions: DropTargetRegion[], pointer: { x: number; y: number }): DropTarget | null {
  void pointer.y;
  const target = regions.find((region) => region.allowed);
  if (!target) return null;
  const index = target.tabs.findIndex((tab) => pointer.x < tab.left + tab.width / 2);
  return { region: target.region, index: index === -1 ? target.tabs.length : index };
}
