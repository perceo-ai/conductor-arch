export const CHAT_BOTTOM_STICK_THRESHOLD_PX = 80;

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function isNearScrollBottom(
  metrics: ScrollMetrics,
  thresholdPx = CHAT_BOTTOM_STICK_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= thresholdPx;
}

export function scrollBottomTop(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}
