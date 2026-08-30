// Column sizing for the workspace shell: sidebar | centre | right panel.
//
// Both side panels are drag-resizable and remember their width, but the centre
// column is where the work happens — it must never be squeezed into a sliver by
// a wide sidebar plus a wide inspector on a small display. CSS min-widths keep
// the columns honest while the window resizes; this module keeps a *drag* from
// crossing the same line.

export const LEFT_MIN = 220;
export const LEFT_MAX = 420;
export const SIDEBAR_MIN = LEFT_MIN;
export const SIDEBAR_MAX = LEFT_MAX;
export const RIGHT_MIN = 260;
export const RIGHT_MAX = 440;
export const BOTTOM_MIN = 160;
export const BOTTOM_MAX = 560;
/** Chat stops being usable narrower than this, so no drag may go past it. */
export const CENTER_MIN = 360;

/**
 * Largest width a side panel may be dragged to right now: its own hard max,
 * capped by what is left after the other panel and the centre column's minimum.
 * Never returns less than the panel's own minimum — an over-tight window is
 * handled by CSS shrinking, not by an impossible drag range.
 */
export function panelDragMax(opts: {
  viewportWidth: number;
  otherPanelWidth: number;
  hardMax: number;
  panelMin: number;
  centerMin?: number;
}): number {
  const centerMin = opts.centerMin ?? CENTER_MIN;
  const available = opts.viewportWidth - opts.otherPanelWidth - centerMin;
  return Math.max(opts.panelMin, Math.min(opts.hardMax, available));
}

/** Width of a laid-out element, or 0 when it is collapsed or absent. */
export function measuredWidth(selector: string): number {
  if (typeof document === "undefined") return 0;
  const el = document.querySelector(selector);
  return el instanceof HTMLElement ? el.offsetWidth : 0;
}

/** Per-panel minimum widths. Panels absent here take DEFAULT_PANEL_MIN. */
const DEFAULT_PANEL_MIN = 220;
export const PANEL_MIN_PX: Record<string, number> = {
  chat: CENTER_MIN,
  terminal: BOTTOM_MIN,
};

export function panelMinPx(panelId: string): number {
  return PANEL_MIN_PX[panelId] ?? DEFAULT_PANEL_MIN;
}

/**
 * Clamp a split ratio so neither child falls below its minimum. When the space
 * cannot satisfy both, share it evenly rather than starving one child.
 */
export function clampSplitRatio(
  availablePx: number,
  ratio: number,
  firstMinPx: number,
  secondMinPx: number,
): number {
  if (availablePx <= 0) return 0.5;
  if (firstMinPx + secondMinPx >= availablePx) return 0.5;
  const min = firstMinPx / availablePx;
  const max = 1 - secondMinPx / availablePx;
  return Math.max(min, Math.min(max, ratio));
}
