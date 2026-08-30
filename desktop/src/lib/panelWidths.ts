// Column sizing for the workspace shell: sidebar | workbench.
//
// The sidebar is drag-resizable and remembers its width, but the workbench is
// where the work happens — it must never be squeezed into a sliver by a wide
// sidebar on a small display. CSS min-widths keep the columns honest while the
// window resizes; this module keeps a *drag* from crossing the same line, and
// owns the per-panel minimums each split inside the workbench clamps against.

export const LEFT_MIN = 220;
export const LEFT_MAX = 420;
export const SIDEBAR_MIN = LEFT_MIN;
export const SIDEBAR_MAX = LEFT_MAX;
export const BOTTOM_MIN = 160;
/** Chat stops being usable narrower than this, so no drag may go past it. */
export const CENTER_MIN = 360;

/**
 * Largest width a side panel may be dragged to right now: its own hard max,
 * capped by what is left after any other fixed column and the workbench's
 * minimum. Never returns less than the panel's own minimum — an over-tight
 * window is handled by CSS shrinking, not by an impossible drag range.
 *
 * `otherPanelWidth` is optional and defaults to 0: with the region model gone
 * the shell is sidebar + workbench, and there is no second fixed column to
 * discount. It is kept because the parameter is the shape of the rule, not of
 * today's shell.
 */
export function panelDragMax(opts: {
  viewportWidth: number;
  otherPanelWidth?: number;
  hardMax: number;
  panelMin: number;
  centerMin?: number;
}): number {
  const centerMin = opts.centerMin ?? CENTER_MIN;
  const available = opts.viewportWidth - (opts.otherPanelWidth ?? 0) - centerMin;
  return Math.max(opts.panelMin, Math.min(opts.hardMax, available));
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
 * Per-panel minimum *heights*, for clamping a column split.
 *
 * These are a separate table rather than a direction argument to `panelMinPx`
 * because the two axes disagree about almost everything: the default is much
 * smaller (a panel needs a usable column, but only a few rows), and the panels
 * that are exceptions differ — chat's 360px width floor says nothing about how
 * short it may be, while `pr` is a one-line strip that is exactly as tall as
 * its own chrome and must not be padded out to a width-shaped minimum.
 *
 * Using the width table on a column is what silently overrode the Code and
 * Review presets' 0.12 PR strip: 220/860 clamps the ratio up to 0.256.
 */
const DEFAULT_PANEL_MIN_HEIGHT = 80;
export const PANEL_MIN_HEIGHT_PX: Record<string, number> = {
  chat: 240,
  terminal: BOTTOM_MIN,
  // The PR bar is a single row of chrome; 40px is the strip's own min-height.
  pr: 40,
};

export function panelMinHeightPx(panelId: string): number {
  return PANEL_MIN_HEIGHT_PX[panelId] ?? DEFAULT_PANEL_MIN_HEIGHT;
}

/** The extent a collapsed subtree keeps: a header in a column, a rail in a row. */
export const COLLAPSED_HEADER_PX = 40;
export const COLLAPSED_RAIL_PX = 36;

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
