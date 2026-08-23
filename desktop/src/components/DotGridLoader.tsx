import { For, createMemo } from "solid-js";
import { DEFAULT_DOT_GRID, dotGridDelays, type DotGridSpec } from "@/lib/dotGrid";

/** Flowing dot-grid loader: a matrix of dots running one shared keyframe with
 *  per-dot phase offsets, which reads as a wave travelling across the grid.
 *
 *  The delays are computed once and pinned as an inline custom property rather
 *  than recomputed reactively — the grid never changes shape while mounted, and
 *  36 reactive style writes per frame would be pure waste.
 *
 *  Announced via role="status" so the wait is perceivable without seeing it;
 *  the dots themselves are decorative and hidden from the accessibility tree. */
export default function DotGridLoader(props: {
  /** Announced to assistive tech and shown beside the grid. */
  label?: string;
  spec?: DotGridSpec;
  class?: string;
}) {
  const spec = () => props.spec ?? DEFAULT_DOT_GRID;
  const delays = createMemo(() => dotGridDelays(spec()));
  return (
    <div class={`dot-grid-loader ${props.class ?? ""}`} role="status" aria-live="polite">
      <div
        class="dot-grid-loader-grid"
        aria-hidden="true"
        style={{ "grid-template-columns": `repeat(${spec().cols}, var(--dot-grid-cell))` }}
      >
        <For each={delays()}>
          {(dot) => (
            <span
              class="dot-grid-loader-dot"
              style={{ "animation-delay": `${dot.delayMs.toFixed(1)}ms` }}
            />
          )}
        </For>
      </div>
      <span class="dot-grid-loader-label">{props.label ?? "Working"}</span>
    </div>
  );
}
