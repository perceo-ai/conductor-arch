/** Geometry for the flowing dot-grid loader.
 *
 * The visual is a matrix of dots that all run the same looping keyframe; the
 * only thing that differs per dot is when its loop starts. Offsetting the start
 * along a diagonal is what turns independent blinking into one wave travelling
 * across the grid — so the wave shape lives here, as arithmetic, rather than in
 * CSS where it could not be tested.
 *
 * Kept free of DOM and of Solid so the phase relationships (the part that is
 * actually easy to get wrong) can be asserted directly.
 */

export interface DotGridSpec {
  rows: number;
  cols: number;
  /** Full loop length in ms. One wave crest traverses the grid per period. */
  periodMs: number;
  /**
   * How much of the period is spread across the grid, 0..1. At 1 the leading
   * and trailing dots are a full period apart — which is the same phase, so the
   * wave becomes invisible. Below 1 the grid holds a partial wave and the crest
   * reads as travelling.
   */
  spread: number;
  /**
   * Row-to-row phase offset as a fraction of the per-column step. 0 gives
   * vertical bars marching sideways; >0 tilts the crest into a diagonal, which
   * is what makes it read as organic rather than mechanical.
   */
  rowSkew: number;
}

export const DEFAULT_DOT_GRID: DotGridSpec = {
  rows: 4,
  cols: 14,
  periodMs: 1800,
  spread: 0.62,
  rowSkew: 0.55,
};

export interface DotDelay {
  row: number;
  col: number;
  /** Negative: CSS treats a negative delay as "already this far in", so every
   *  dot is mid-loop on the first frame and the wave is present immediately
   *  instead of building up over one full period. */
  delayMs: number;
}

/**
 * Delay for one dot, in ms. Always in `(-periodMs, 0]`.
 *
 * Phase advances with `col + row * rowSkew`, normalised by the largest such
 * value in the grid so the spread is independent of the grid's dimensions —
 * a 3x12 and a 5x20 grid show the same amount of wave.
 */
export function dotWaveDelay(row: number, col: number, spec: DotGridSpec = DEFAULT_DOT_GRID): number {
  const { rows, cols, periodMs, spread, rowSkew } = spec;
  if (rows <= 0 || cols <= 0) return 0;

  // Largest phase coordinate present in the grid. Guard the 1x1 case, where
  // the span is 0 and there is nothing to normalise against.
  const span = (cols - 1) + (rows - 1) * rowSkew;
  const phase = span === 0 ? 0 : ((col + row * rowSkew) / span) * spread;

  // Wrap into one period, then negate: the dot starts `phase` into its loop.
  const wrapped = phase - Math.floor(phase);
  return -(wrapped * periodMs);
}

/** Every dot in the grid, row-major — the order the DOM renders them in. */
export function dotGridDelays(spec: DotGridSpec = DEFAULT_DOT_GRID): DotDelay[] {
  const out: DotDelay[] = [];
  for (let row = 0; row < spec.rows; row += 1) {
    for (let col = 0; col < spec.cols; col += 1) {
      out.push({ row, col, delayMs: dotWaveDelay(row, col, spec) });
    }
  }
  return out;
}
