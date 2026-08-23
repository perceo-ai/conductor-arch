import { describe, expect, it } from "vitest";
import { DEFAULT_DOT_GRID, dotGridDelays, dotWaveDelay, type DotGridSpec } from "./dotGrid";

const spec = DEFAULT_DOT_GRID;

describe("dotWaveDelay", () => {
  it("starts the origin dot at the beginning of its loop", () => {
    expect(dotWaveDelay(0, 0, spec)).toBe(-0);
  });

  it("advances phase monotonically along a row", () => {
    const row = Array.from({ length: spec.cols }, (_, col) => dotWaveDelay(0, col, spec));
    for (let i = 1; i < row.length; i += 1) {
      // More negative == further into the loop == later in the wave.
      expect(row[i]).toBeLessThan(row[i - 1]);
    }
  });

  it("advances phase down a column, so the crest is diagonal not vertical", () => {
    const col = Array.from({ length: spec.rows }, (_, row) => dotWaveDelay(row, 0, spec));
    for (let i = 1; i < col.length; i += 1) {
      expect(col[i]).toBeLessThan(col[i - 1]);
    }
  });

  it("keeps every delay inside one period", () => {
    for (const { delayMs } of dotGridDelays(spec)) {
      expect(delayMs).toBeLessThanOrEqual(0);
      expect(delayMs).toBeGreaterThan(-spec.periodMs);
    }
  });

  it("spreads at most `spread` of the period across the whole grid", () => {
    const delays = dotGridDelays(spec).map((d) => d.delayMs);
    const widest = Math.max(...delays) - Math.min(...delays);
    expect(widest).toBeLessThanOrEqual(spec.periodMs * spec.spread + 1e-9);
  });

  it("gives the same phase profile regardless of grid size", () => {
    // Normalisation by grid span is what lets the loader be resized without
    // retuning the wave; assert the last dot lands at the same phase in both.
    const small: DotGridSpec = { ...spec, rows: 3, cols: 12 };
    const large: DotGridSpec = { ...spec, rows: 5, cols: 20 };
    const lastSmall = dotWaveDelay(small.rows - 1, small.cols - 1, small);
    const lastLarge = dotWaveDelay(large.rows - 1, large.cols - 1, large);
    expect(lastSmall).toBeCloseTo(lastLarge, 6);
  });

  it("survives degenerate grids rather than emitting NaN", () => {
    expect(dotWaveDelay(0, 0, { ...spec, rows: 1, cols: 1 })).toBe(-0);
    expect(dotWaveDelay(0, 0, { ...spec, rows: 0, cols: 0 })).toBe(0);
    expect(Number.isFinite(dotWaveDelay(0, 0, { ...spec, rows: 1, cols: 1 }))).toBe(true);
  });

  it("tilts the crest more as rowSkew grows", () => {
    const flat = dotWaveDelay(1, 0, { ...spec, rowSkew: 0 });
    const tilted = dotWaveDelay(1, 0, { ...spec, rowSkew: 1 });
    expect(flat).toBe(-0);
    expect(tilted).toBeLessThan(flat);
  });
});

describe("dotGridDelays", () => {
  it("emits every cell once, row-major", () => {
    const delays = dotGridDelays(spec);
    expect(delays).toHaveLength(spec.rows * spec.cols);
    expect(delays[0]).toMatchObject({ row: 0, col: 0 });
    expect(delays[spec.cols]).toMatchObject({ row: 1, col: 0 });
    expect(delays.at(-1)).toMatchObject({ row: spec.rows - 1, col: spec.cols - 1 });
  });
});
