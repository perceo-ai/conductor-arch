export type ListMove = "next" | "previous" | "first" | "last";

export function nextListIndex(current: number, length: number, move: ListMove): number {
  if (length <= 0) return 0;
  if (move === "first") return 0;
  if (move === "last") return length - 1;
  const normalized = Math.max(0, Math.min(current, length - 1));
  if (move === "next") return (normalized + 1) % length;
  return (normalized - 1 + length) % length;
}
