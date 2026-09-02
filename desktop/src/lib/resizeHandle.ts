import type { Rect, SplitDirection } from "./layout";

export type ResizeEdge = "left" | "right" | "top";

export function keyboardResize(
  edge: ResizeEdge,
  key: string,
  current: number,
  min: number,
  max: number,
  largeStep: boolean,
): number | undefined {
  const step = largeStep ? 40 : 10;
  let next: number | undefined;
  if (key === "Home") next = min;
  if (key === "End") next = max;
  if (edge === "right" && key === "ArrowRight") next = current + step;
  if (edge === "right" && key === "ArrowLeft") next = current - step;
  if (edge === "left" && key === "ArrowLeft") next = current + step;
  if (edge === "left" && key === "ArrowRight") next = current - step;
  if (edge === "top" && key === "ArrowUp") next = current + step;
  if (edge === "top" && key === "ArrowDown") next = current - step;
  return next === undefined ? undefined : Math.max(min, Math.min(max, next));
}

/**
 * The ratio a split's first child would occupy if its resize handle were
 * dragged to `pointer`, given the split's on-screen rect and orientation.
 * Pure geometry against a measured rect — the caller (`setRatio`) clamps the
 * result into a sane range and decides whether the change is worth
 * committing, the same division of labour `resolveDrop` keeps in layout.ts.
 */
export function dragRatio(direction: SplitDirection, rect: Rect, pointer: { x: number; y: number }): number {
  if (direction === "row") {
    return rect.width <= 0 ? 0.5 : (pointer.x - rect.left) / rect.width;
  }
  return rect.height <= 0 ? 0.5 : (pointer.y - rect.top) / rect.height;
}
