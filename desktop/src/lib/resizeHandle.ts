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
